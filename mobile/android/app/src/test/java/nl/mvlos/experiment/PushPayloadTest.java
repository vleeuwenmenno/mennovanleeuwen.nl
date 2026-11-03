package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PushPayloadTest {
    private static final String RID = "AAAAAAAAAAAAAAAAAAAAAA";
    private static final String NID = "BBBBBBBBBBBBBBBBBBBBBB";

    private static Map<String, String> ok() {
        Map<String, String> m = new HashMap<>();
        m.put("v", "1");
        m.put("rid", RID);
        m.put("nid", NID);
        m.put("k", "mail");
        return m;
    }

    @Test
    public void exactlyTheFourKeys() {
        PushPayload p = PushPayload.parse(ok());
        assertNotNull(p);
        assertEquals(RID, p.rid);
        assertEquals(NID, p.nid);
        assertEquals("mail", p.kind);
    }

    @Test
    public void anythingElseIsDropped() {
        assertNull(PushPayload.parse(null));
        Map<String, String> m = ok();
        m.put("t", "Title");
        assertNull(PushPayload.parse(m));
        m = ok();
        m.put("v", "2");
        assertNull(PushPayload.parse(m));
        m = ok();
        m.put("rid", "short");
        assertNull(PushPayload.parse(m));
        m = ok();
        m.put("nid", RID + "x");
        assertNull(PushPayload.parse(m));
        m = ok();
        m.put("k", "evil");
        assertNull(PushPayload.parse(m));
        m = ok();
        m.remove("k");
        m.put("x", "y");
        assertNull(PushPayload.parse(m));
    }
}
