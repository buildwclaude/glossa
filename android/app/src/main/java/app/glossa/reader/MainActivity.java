package app.glossa.reader;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GlossaPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** Volume keys turn pages while a book is open (if enabled in settings). */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        GlossaPlugin p = GlossaPlugin.instance;
        int code = event.getKeyCode();
        if (p != null && p.volumeKeys && (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) p.volumeKey(code == KeyEvent.KEYCODE_VOLUME_DOWN ? "down" : "up");
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
