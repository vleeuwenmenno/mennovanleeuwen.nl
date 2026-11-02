package nl.mvlos.experiment;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * What a push message from Firebase may say: opaque ids and a coarse kind, nothing the user reads
 * (server/nativepush.ts). Anything else, including extra keys, is dropped. Plain Java.
 */
public final class PushPayload {
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final List<String> KINDS = Arrays.asList("mail", "agents", "tasks", "calendar", "generic");

    public final String rid;
    public final String nid;
    public final String kind;

    private PushPayload(String rid, String nid, String kind) {
        this.rid = rid;
        this.nid = nid;
        this.kind = kind;
    }

    /** The payload, or null when the message is not exactly {v:1, rid, nid, k}. */
    public static PushPayload parse(Map<String, String> data) {
        if (data == null || data.size() != 4) return null;
        String v = data.get("v");
        String rid = data.get("rid");
        String nid = data.get("nid");
        String k = data.get("k");
        if (!"1".equals(v) || rid == null || nid == null || k == null) return null;
        if (!ID.matcher(rid).matches() || !ID.matcher(nid).matches() || !KINDS.contains(k)) return null;
        return new PushPayload(rid, nid, k);
    }
}
