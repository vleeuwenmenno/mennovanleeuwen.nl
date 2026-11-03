package nl.mvlos.experiment;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The one owner of the app's push state, in the main process (never the cloud process: the two
 * keep their own copies of preferences). Everything asynchronous (a token callback, a content
 * fetch, a registration answer) remembers the generation it started under and asks again before it
 * does anything: a revoke, an enable or a server switch bumps the generation, so a late result can
 * never undo a revoke or show a message that was cancelled.
 *
 * <p>Secrets (the capability and the revocation key) are sealed by a Box whose key lives in the
 * Android Keystore and are bound to the origin and registration they belong to. A box that cannot
 * open something makes it vanish (fail closed); there is never a plaintext fallback. After a
 * revoke only the revocation key is kept, as a delete-only record for at most 30 days, so a
 * server row can still be removed after an offline Disconnect. Plain Java: the store, the box
 * and the clock are injected, so the rules run in local JUnit tests.
 */
public final class PushState {
    /** Where the state is kept. `commit` writes all of it or none, synchronously. */
    public interface Store {
        String get(String key);

        void commit(Map<String, String> puts, Set<String> removes);
    }

    /** Seals and opens secrets, bound to `aad`. `open` returns null when it cannot (wrong key, tampered, key gone). */
    public interface Box {
        String seal(String plain, String aad);

        String open(String sealed, String aad);
    }

    public interface Clock {
        long now();
    }

    /** What is known about the current registration: no secrets. */
    public static final class Snapshot {
        public final boolean enabled;
        public final String origin;
        public final String uid;
        public final String rid;
        public final long generation;

        Snapshot(boolean enabled, String origin, String uid, String rid, long generation) {
            this.enabled = enabled;
            this.origin = origin;
            this.uid = uid;
            this.rid = rid;
            this.generation = generation;
        }
    }

    /** The capability with the origin and registration it belongs to, read in ONE step under one generation: never mixed from two reads. */
    public static final class Credential {
        public final String origin;
        public final String rid;
        public final String capability;

        Credential(String origin, String rid, String capability) {
            this.origin = origin;
            this.rid = rid;
            this.capability = capability;
        }
    }

    /** A registration to delete on the server when the network allows: its revocation credential (`rid.secret`, as the server gave it) only. */
    public static final class Pending {
        public final String origin;
        public final String rid;
        public final String revocationKey;
        public final long until;

        Pending(String origin, String rid, String revocationKey, long until) {
            this.origin = origin;
            this.rid = rid;
            this.revocationKey = revocationKey;
            this.until = until;
        }
    }

    public static final long PENDING_FOR_MS = 30L * 24 * 3600 * 1000;
    private static final String K_ENABLED = "enabled";
    private static final String K_ORIGIN = "origin";
    private static final String K_UID = "uid";
    private static final String K_RID = "rid";
    private static final String K_CAP = "cap";
    private static final String K_REV = "rev";
    private static final String K_GEN = "gen";
    private static final String K_INSTALL = "install";
    private static final String K_PENDING = "pending";

    private final Store store;
    private final Box box;
    private final Clock clock;
    private final java.util.function.Supplier<String> random;

    public PushState(Store store, Box box, Clock clock, java.util.function.Supplier<String> random) {
        this.store = store;
        this.box = box;
        this.clock = clock;
        this.random = random;
    }

    private static String aad(String origin, String rid, String kind) {
        return origin + "|" + rid + "|" + kind;
    }

    private long gen() {
        try {
            String g = store.get(K_GEN);
            return g == null ? 0 : Long.parseLong(g);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** This installation's random id (made once). It is not a hardware id and is regenerated on a fresh install. */
    public synchronized String installId() {
        String id = store.get(K_INSTALL);
        if (id == null || id.isEmpty()) {
            id = random.get();
            store.commit(Collections.singletonMap(K_INSTALL, id), Collections.<String>emptySet());
        }
        return id;
    }

    public synchronized long generation() {
        return gen();
    }

    public synchronized Snapshot snapshot() {
        boolean enabled = "1".equals(store.get(K_ENABLED)) && store.get(K_RID) != null && store.get(K_ORIGIN) != null;
        return new Snapshot(enabled, enabled ? store.get(K_ORIGIN) : null, enabled ? store.get(K_UID) : null, enabled ? store.get(K_RID) : null, gen());
    }

    /**
     * Makes a registration the current one (after the user confirmed and the server activated it).
     * Replaces whatever was there (its revocation key goes to the delete-only list). Bumps the generation.
     */
    public synchronized Snapshot enroll(String origin, String uid, String rid, String capability, String revocationKey) {
        Map<String, String> puts = new HashMap<>();
        Set<String> removes = new HashSet<>();
        retireCurrent(puts);
        puts.put(K_ENABLED, "1");
        puts.put(K_ORIGIN, origin);
        puts.put(K_UID, uid);
        puts.put(K_RID, rid);
        puts.put(K_CAP, box.seal(capability, aad(origin, rid, "cap")));
        puts.put(K_REV, box.seal(revocationKey, aad(origin, rid, "rev")));
        long next = gen() + 1;
        puts.put(K_GEN, Long.toString(next));
        store.commit(puts, removes);
        return snapshot();
    }

    /** Everything stops now: no further message is accepted, shown or fetched. The revocation key stays, delete-only. Bumps the generation. */
    public synchronized Snapshot revoke() {
        Map<String, String> puts = new HashMap<>();
        retireCurrent(puts);
        Set<String> removes = new HashSet<>(java.util.Arrays.asList(K_ENABLED, K_ORIGIN, K_UID, K_RID, K_CAP, K_REV));
        puts.put(K_GEN, Long.toString(gen() + 1));
        store.commit(puts, removes);
        return snapshot();
    }

    /** The capability, only while `generation` is still current and the registration is the enabled one; else null. */
    public synchronized String capability(long generation, String rid) {
        Snapshot s = snapshot();
        if (!s.enabled || s.generation != generation || !s.rid.equals(rid)) return null;
        String sealed = store.get(K_CAP);
        String opened = sealed == null ? null : box.open(sealed, aad(s.origin, s.rid, "cap"));
        // A secret that cannot be opened (the key is gone) ends the registration instead of weakening it.
        if (opened == null) revoke();
        return opened;
    }

    /** Origin, registration and capability together, only while `generation` is still current; else null (and a secret that cannot be opened ends the registration). */
    public synchronized Credential credential(long generation, String rid) {
        Snapshot s = snapshot();
        if (!s.enabled || s.generation != generation || !s.rid.equals(rid)) return null;
        String cap = capability(generation, rid);
        return cap == null ? null : new Credential(s.origin, s.rid, cap);
    }

    public synchronized boolean isCurrent(long generation, String rid) {
        Snapshot s = snapshot();
        return s.enabled && s.generation == generation && s.rid.equals(rid);
    }

    /** Delete-only records still worth trying (expired ones are dropped). */
    public synchronized List<Pending> pending() {
        List<Pending> out = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        String raw = store.get(K_PENDING);
        if (raw != null) {
            for (String line : raw.split("\n")) {
                String[] f = line.split("\t", -1);
                if (f.length != 4) continue;
                long until;
                try {
                    until = Long.parseLong(f[3]);
                } catch (NumberFormatException e) {
                    continue;
                }
                if (until <= clock.now()) continue;
                String key = box.open(f[2], aad(f[0], f[1], "rev"));
                if (key == null) continue;
                out.add(new Pending(f[0], f[1], key, until));
                lines.add(line);
            }
            String joined = String.join("\n", lines);
            if (!joined.equals(raw)) {
                if (joined.isEmpty()) store.commit(Collections.<String, String>emptyMap(), Collections.singleton(K_PENDING));
                else store.commit(Collections.singletonMap(K_PENDING, joined), Collections.<String>emptySet());
            }
        }
        return out;
    }

    /** Keeps a revocation credential for a registration the app made but cannot keep (an opt-in that failed after activation): deleted on the server when the network allows. */
    public synchronized void rememberForDeletion(String origin, String rid, String revocationCredential) {
        List<String> lines = new ArrayList<>();
        String raw = store.get(K_PENDING);
        if (raw != null) for (String line : raw.split("\n")) if (!line.isEmpty()) lines.add(line);
        lines.add(origin + "\t" + rid + "\t" + box.seal(revocationCredential, aad(origin, rid, "rev")) + "\t" + (clock.now() + PENDING_FOR_MS));
        while (lines.size() > 8) lines.remove(0);
        store.commit(Collections.singletonMap(K_PENDING, String.join("\n", lines)), Collections.<String>emptySet());
    }

    /** The server confirmed (or no longer knows) this registration: its record goes. */
    public synchronized void dropPending(String rid) {
        String raw = store.get(K_PENDING);
        if (raw == null) return;
        List<String> keep = new ArrayList<>();
        for (String line : raw.split("\n")) {
            String[] f = line.split("\t", -1);
            if (f.length == 4 && !f[1].equals(rid)) keep.add(line);
        }
        String joined = String.join("\n", keep);
        if (joined.isEmpty()) store.commit(Collections.<String, String>emptyMap(), Collections.singleton(K_PENDING));
        else store.commit(Collections.singletonMap(K_PENDING, joined), Collections.<String>emptySet());
    }

    /** Moves the current registration's revocation key to the delete-only list (into `puts`). */
    private void retireCurrent(Map<String, String> puts) {
        Snapshot s = snapshot();
        List<String> lines = new ArrayList<>();
        String raw = store.get(K_PENDING);
        if (raw != null) for (String line : raw.split("\n")) if (!line.isEmpty()) lines.add(line);
        if (s.enabled) {
            String revSealed = store.get(K_REV);
            String rev = revSealed == null ? null : box.open(revSealed, aad(s.origin, s.rid, "rev"));
            if (rev != null) lines.add(s.origin + "\t" + s.rid + "\t" + box.seal(rev, aad(s.origin, s.rid, "rev")) + "\t" + (clock.now() + PENDING_FOR_MS));
        }
        if (lines.isEmpty()) return;
        // At most a handful: the oldest go first.
        while (lines.size() > 8) lines.remove(0);
        puts.put(K_PENDING, String.join("\n", lines));
    }
}
