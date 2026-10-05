package app.glossa.reader;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.pm.PackageManager;
import android.os.Environment;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Glossa's own bridge to Android:
 *  - books handed over by other apps ("Open with", "Share") are copied into
 *    the cache and passed to the web layer, which adds them to the library;
 *  - the screen stays on while a book is open;
 *  - the volume keys can turn pages;
 *  - with the user's permission, the device is scanned for books and
 *    documents (like VLC finds videos), which are then read in place.
 */
@CapacitorPlugin(
    name = "Glossa",
    permissions = { @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "storage") }
)
public class GlossaPlugin extends Plugin {

    static GlossaPlugin instance;
    volatile boolean volumeKeys = false;

    @Override
    public void load() {
        instance = this;
        cleanIncoming();
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    @PluginMethod
    public void takePendingFiles(PluginCall call) {
        // Files are delivered through the retained "fileOpened" event; this
        // stays for the web layer's start-up handshake.
        JSObject ret = new JSObject();
        ret.put("files", new JSArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void setVolumeKeys(PluginCall call) {
        volumeKeys = Boolean.TRUE.equals(call.getBoolean("on", false));
        call.resolve();
    }

    void volumeKey(String key) {
        JSObject data = new JSObject();
        data.put("key", key);
        notifyListeners("volumeKey", data);
    }

    /* ------------------------------------------------------------- scanning */

    private static final Set<String> BOOK_EXTS = new HashSet<>(Arrays.asList(
        "epub", "pdf", "mobi", "azw", "azw3", "kf8", "prc", "fb2", "fbz", "cbz", "docx"
    ));

    private boolean hasStorage() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private void resolveStorage(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasStorage());
        call.resolve(r);
    }

    @PluginMethod
    public void storageStatus(PluginCall call) {
        resolveStorage(call);
    }

    @PluginMethod
    public void requestStorage(PluginCall call) {
        if (hasStorage()) {
            resolveStorage(call);
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            try {
                startActivityForResult(call, intent, "storageResult");
            } catch (ActivityNotFoundException e) {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "storageResult");
            }
        } else {
            requestPermissionForAlias("storage", call, "storagePermResult");
        }
    }

    @ActivityCallback
    private void storageResult(PluginCall call, ActivityResult result) {
        if (call != null) resolveStorage(call);
    }

    @PermissionCallback
    private void storagePermResult(PluginCall call) {
        resolveStorage(call);
    }

    /** Walks shared storage (and SD cards) for books and documents. */
    @PluginMethod
    public void scan(PluginCall call) {
        if (!hasStorage()) {
            call.reject("No storage access");
            return;
        }
        new Thread(() -> {
            JSArray files = new JSArray();
            Set<String> roots = new HashSet<>();
            roots.add(Environment.getExternalStorageDirectory().getAbsolutePath());
            for (File f : getContext().getExternalFilesDirs(null)) {
                if (f == null) continue;
                String p = f.getAbsolutePath();
                int i = p.indexOf("/Android/");
                if (i > 0) roots.add(p.substring(0, i));
            }
            Set<String> seen = new HashSet<>();
            int count = 0;
            for (String root : roots) {
                Deque<Object[]> stack = new ArrayDeque<>();
                stack.push(new Object[] { new File(root), 0 });
                while (!stack.isEmpty() && count < 20000) {
                    Object[] top = stack.pop();
                    File dir = (File) top[0];
                    int depth = (Integer) top[1];
                    File[] list = dir.listFiles();
                    if (list == null) continue;
                    for (File f : list) {
                        String name = f.getName();
                        if (name.startsWith(".")) continue;
                        if (f.isDirectory()) {
                            // App-private data and caches are never the user's books.
                            if (depth == 0 && name.equals("Android")) continue;
                            if (depth < 14) stack.push(new Object[] { f, depth + 1 });
                            continue;
                        }
                        int dot = name.lastIndexOf('.');
                        if (dot < 0) continue;
                        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
                        if (!BOOK_EXTS.contains(ext) || f.length() < 1024) continue;
                        String path;
                        try {
                            path = f.getCanonicalPath();
                        } catch (Exception e) {
                            path = f.getAbsolutePath();
                        }
                        if (!seen.add(path)) continue;
                        JSObject o = new JSObject();
                        o.put("path", path);
                        o.put("name", name);
                        o.put("size", f.length());
                        o.put("modified", f.lastModified());
                        files.put(o);
                        count++;
                    }
                }
            }
            JSObject r = new JSObject();
            r.put("files", files);
            call.resolve(r);
        }).start();
    }

    /* ----------------------------------------------------------- intents */

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        // Don't hand the same file over again if the activity is recreated.
        intent.setAction(Intent.ACTION_MAIN);

        new Thread(() -> {
            JSArray files = new JSArray();
            for (Uri uri : uris) {
                try {
                    files.put(copyToCache(uri));
                } catch (Exception e) {
                    android.util.Log.w("Glossa", "Could not read " + uri, e);
                }
            }
            if (files.length() == 0) return;
            JSObject data = new JSObject();
            data.put("files", files);
            // Retained until the web layer is listening, so a cold start
            // from "Open with" never loses the book.
            notifyListeners("fileOpened", data, true);
        }).start();
    }

    private JSObject copyToCache(Uri uri) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String name = displayName(resolver, uri);
        String mime = resolver.getType(uri);
        File dir = new File(getContext().getCacheDir(), "incoming");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("no cache dir");
        File out = new File(dir, System.currentTimeMillis() + "-" + name);
        try (InputStream in = resolver.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new IllegalStateException("no stream");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
        JSObject f = new JSObject();
        f.put("path", out.getAbsolutePath());
        f.put("name", name);
        if (mime != null) f.put("mime", mime);
        return f;
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
                // fall back to the path below
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "book";
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[^\\w.\\- ()\\[\\]]", "_");
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    /** Files handed over earlier have been imported (or abandoned) by now. */
    private void cleanIncoming() {
        File dir = new File(getContext().getCacheDir(), "incoming");
        File[] old = dir.listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - 60 * 60 * 1000;
        for (File f : old) if (f.lastModified() < cutoff) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }
}
