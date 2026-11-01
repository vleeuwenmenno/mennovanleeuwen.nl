package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;

import nl.mvlos.experiment.CloudPolicy.Action;
import org.junit.Test;

public class CloudPolicyTest {
    private static final String O = "https://mvl.example";

    private static Action c(String url) {
        return CloudPolicy.classify(O, url);
    }

    @Test
    public void ownOriginStays() {
        assertEquals(Action.STAY, c("https://mvl.example/"));
        assertEquals(Action.STAY, c("https://MVL.example:443/?open=settings"));
        assertEquals(Action.STAY, c("https://mvl.example/api/auth/app/redeem"));
        assertEquals(Action.STAY, c("https://mvl.example/api/auth/github/callback?code=x"));
    }

    @Test
    public void signInStartsAreTakenOver() {
        assertEquals(Action.LOGIN_GITHUB, c("https://mvl.example/api/auth/github/login"));
        assertEquals(Action.LOGIN_GITHUB, c("https://mvl.example/api/auth/github/login?back=%2Fcv"));
        assertEquals(Action.LOGIN_GOOGLE, c("https://mvl.example/api/auth/google/login"));
        assertEquals(Action.BLOCK, c("https://mvl.example/api/auth/app/start?provider=github"));
    }

    @Test
    public void otherOriginsNeverLoad() {
        assertEquals(Action.EXTERNAL, c("https://mvl.example:8443/"));
        assertEquals(Action.EXTERNAL, c("https://evil.example/"));
        assertEquals(Action.EXTERNAL, c("https://mvl.example.evil.example/"));
        assertEquals(Action.BLOCK, c("http://mvl.example/"));
        assertEquals(Action.BLOCK, c("https://user@mvl.example/"));
        assertEquals(Action.BLOCK, c("javascript:alert(1)"));
        assertEquals(Action.BLOCK, c("data:text/html,hi"));
        assertEquals(Action.BLOCK, c("file:///data/data/nl.mvlos.experiment/"));
        assertEquals(Action.BLOCK, c("intent://x#Intent;scheme=nl.mvlos.experiment;end"));
        assertEquals(Action.BLOCK, c("nl.mvlos.experiment:/oauth?code=x&state=y"));
        assertEquals(Action.EXTERNAL, c("mailto:a@b.example"));
    }

    @Test
    public void providerPagesNeverLoadInTheApp() {
        assertEquals(Action.PROVIDER_PAGE, c("https://github.com/login/oauth/authorize?client_id=x"));
        assertEquals(Action.PROVIDER_PAGE, c("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
        assertEquals(Action.EXTERNAL, c("https://github.com/vleeuwenmenno"));
    }

    @Test
    public void chooserLink() {
        assertEquals(Action.CHOOSER, c("mvlosapp://chooser"));
        assertEquals(Action.BLOCK, c("mvlosapp://other"));
    }

    @Test
    public void portsAndIpv6() {
        assertEquals(Action.STAY, CloudPolicy.classify("https://localhost:8443", "https://localhost:8443/x"));
        assertEquals(Action.EXTERNAL, CloudPolicy.classify("https://localhost:8443", "https://localhost/x"));
        assertEquals(Action.STAY, CloudPolicy.classify("https://[2001:db8::1]", "https://[2001:db8::1]/"));
    }
}
