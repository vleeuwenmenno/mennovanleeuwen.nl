package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class PushStateTest {
    private static final String O = "https://mvl.example";

    private static final class MemoryStore implements PushState.Store {
        final Map<String, String> data = new HashMap<>();

        @Override
        public String get(String key) {
            return data.get(key);
        }

        @Override
        public void commit(Map<String, String> puts, Set<String> removes) {
            data.keySet().removeAll(removes);
            data.putAll(puts);
        }
    }

    /** A box whose output says what it was bound to, so a wrong binding cannot open. */
    private static final class FakeBox implements PushState.Box {
        boolean keyGone;

        @Override
        public String seal(String plain, String aad) {
            return "sealed:" + aad.length() + ":" + aad + ":" + plain;
        }

        @Override
        public String open(String sealed, String aad) {
            if (keyGone) return null;
            String prefix = "sealed:" + aad.length() + ":" + aad + ":";
            return sealed.startsWith(prefix) ? sealed.substring(prefix.length()) : null;
        }
    }

    private final MemoryStore store = new MemoryStore();
    private final FakeBox box = new FakeBox();
    private long now = 1_000_000L;
    private int n = 0;
    private final PushState state = new PushState(store, box, () -> now, () -> "install-" + (++n));

    @Test
    public void installIdIsMadeOnce() {
        assertEquals("install-1", state.installId());
        assertEquals("install-1", state.installId());
    }

    @Test
    public void startsOff() {
        PushState.Snapshot s = state.snapshot();
        assertFalse(s.enabled);
        assertNull(s.rid);
        assertNull(state.capability(state.generation(), "x"));
    }

    @Test
    public void enrollMakesItCurrentAndBumpsTheGeneration() {
        long before = state.generation();
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap-secret", "rev-secret");
        assertTrue(s.enabled);
        assertEquals(O, s.origin);
        assertEquals("7", s.uid);
        assertEquals(before + 1, s.generation);
        assertEquals("cap-secret", state.capability(s.generation, "RID"));
        assertTrue(state.isCurrent(s.generation, "RID"));
        assertFalse("secrets are not stored in the clear", store.data.values().toString().contains("cap-secret") && !store.data.get("cap").startsWith("sealed:"));
    }

    @Test
    public void aStaleGenerationOrRegistrationGetsNothing() {
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap", "rev");
        assertNull(state.capability(s.generation - 1, "RID"));
        assertNull(state.capability(s.generation, "OTHER"));
        assertFalse(state.isCurrent(s.generation + 1, "RID"));
    }

    @Test
    public void revokeStopsEverythingAtOnceAndKeepsOnlyTheRevocationKey() {
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap", "rev");
        PushState.Snapshot r = state.revoke();
        assertFalse(r.enabled);
        assertEquals(s.generation + 1, r.generation);
        assertNull(state.capability(r.generation, "RID"));
        assertNull(state.capability(s.generation, "RID"));
        assertFalse(state.isCurrent(s.generation, "RID"));
        List<PushState.Pending> p = state.pending();
        assertEquals(1, p.size());
        assertEquals("RID", p.get(0).rid);
        assertEquals("rev", p.get(0).revocationKey);
        assertEquals(O, p.get(0).origin);
        assertFalse("the capability is gone", store.data.containsKey("cap"));
    }

    @Test
    public void aLateResultOfARevokedRegistrationCannotBringItBack() {
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap", "rev");
        long started = s.generation;
        state.revoke();
        // A callback that began before the revoke asks again before it does anything.
        assertFalse(state.isCurrent(started, "RID"));
        assertNull(state.capability(started, "RID"));
    }

    @Test
    public void enrollingAnotherRegistrationRetiresTheFirst() {
        state.enroll(O, "7", "RID1", "cap1", "rev1");
        PushState.Snapshot s2 = state.enroll("https://other.example", "9", "RID2", "cap2", "rev2");
        assertEquals("RID2", s2.rid);
        List<PushState.Pending> p = state.pending();
        assertEquals(1, p.size());
        assertEquals("RID1", p.get(0).rid);
        assertEquals("cap2", state.capability(s2.generation, "RID2"));
    }

    @Test
    public void pendingRecordsExpireAndCanBeDropped() {
        state.enroll(O, "7", "RID1", "cap1", "rev1");
        state.revoke();
        assertEquals(1, state.pending().size());
        now += PushState.PENDING_FOR_MS - 1;
        assertEquals(1, state.pending().size());
        now += 2;
        assertEquals(0, state.pending().size());
        state.enroll(O, "7", "RID3", "cap", "rev");
        state.revoke();
        state.dropPending("RID3");
        assertEquals(0, state.pending().size());
    }

    @Test
    public void aSecretThatCannotBeOpenedEndsTheRegistrationInsteadOfWeakeningIt() {
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap", "rev");
        box.keyGone = true;
        assertNull(state.capability(s.generation, "RID"));
        assertFalse(state.snapshot().enabled);
        assertNotEquals(s.generation, state.generation());
    }

    @Test
    public void aSecretIsBoundToItsOriginAndRegistration() {
        PushState.Snapshot s = state.enroll(O, "7", "RID", "cap", "rev");
        // Moving the sealed capability under another registration id does not open it.
        store.data.put("rid", "OTHER");
        assertNull(state.capability(s.generation, "OTHER"));
    }
}
