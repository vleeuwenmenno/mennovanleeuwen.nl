package nl.mvlos.experiment;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals the push secrets with an AES-GCM key that lives in the Android Keystore and never leaves
 * it, bound to an `aad` (origin, registration, purpose). A key that is gone or a blob that does not
 * open yields null (the registration then ends): there is no plaintext fallback.
 */
final class KeystoreBox implements PushState.Box {
    private static final String ALIAS = "mvlos_push_v1";
    private static final int IV = 12;

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return g.generateKey();
    }

    @Override
    public String seal(String plain, String aad) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.encodeToString(out, Base64.URL_SAFE | Base64.NO_WRAP);
        } catch (Exception e) {
            throw new IllegalStateException("could not seal");
        }
    }

    @Override
    public String open(String sealed, String aad) {
        try {
            byte[] in = Base64.decode(sealed, Base64.URL_SAFE | Base64.NO_WRAP);
            if (in.length <= IV) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(in, 0, IV)));
            c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(in, IV, in.length - IV), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
