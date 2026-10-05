import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/**
 * Everything that talks to Android, each call a no-op in a plain browser.
 * `Glossa` is the app's own small plugin (android/.../GlossaPlugin.java):
 * files opened from other apps, keeping the screen on, volume-key paging.
 */

type IncomingFile = { path: string; name: string; mime?: string };
export type FoundFile = { path: string; name: string; size: number; modified: number };

interface GlossaPlugin {
  takePendingFiles(): Promise<{ files: IncomingFile[] }>;
  setKeepAwake(o: { on: boolean }): Promise<void>;
  setVolumeKeys(o: { on: boolean }): Promise<void>;
  storageStatus(): Promise<{ granted: boolean }>;
  requestStorage(): Promise<{ granted: boolean }>;
  scan(): Promise<{ files: FoundFile[] }>;
  addListener(e: 'fileOpened', cb: (f: { files: IncomingFile[] }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'volumeKey', cb: (k: { key: 'up' | 'down' }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
const Glossa = registerPlugin<GlossaPlugin>('Glossa');

const safe = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
  if (!isNative) return undefined;
  try {
    return await f();
  } catch (e) {
    console.warn(e);
    return undefined;
  }
};

export const native = {
  async immersive(on: boolean) {
    await safe(() => (on ? StatusBar.hide() : StatusBar.show()));
  },
  async statusStyle(dark: boolean) {
    await safe(() => StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }));
  },
  keepAwake: (on: boolean) => safe(() => Glossa.setKeepAwake({ on })),
  volumeKeys: (on: boolean) => safe(() => Glossa.setVolumeKeys({ on })),
  tick: () => safe(() => Haptics.impact({ style: ImpactStyle.Light })),

  onBack(handler: () => void) {
    if (isNative) void App.addListener('backButton', handler);
    else addEventListener('keydown', (e) => e.key === 'Escape' && handler());
  },
  exit: () => safe(() => App.exitApp()),

  /* Device scan: find every book and document, like VLC finds videos. */
  storageGranted: async () => !!(await safe(() => Glossa.storageStatus()))?.granted,
  requestStorage: async () => !!(await safe(() => Glossa.requestStorage()))?.granted,
  scan: async () => (await safe(() => Glossa.scan()))?.files ?? [],
  /** A file on the device, read in place through the app's local server. */
  async readFile(path: string, name: string): Promise<File> {
    const url = Capacitor.convertFileSrc(path.split('/').map(encodeURIComponent).join('/'));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`missing: ${path}`);
    return new File([await res.blob()], name);
  },
  onVolumeKey(handler: (dir: 1 | -1) => void) {
    void safe(() => Glossa.addListener('volumeKey', ({ key }) => handler(key === 'down' ? 1 : -1)));
  },

  /** Books handed to Glossa by another app, at launch and while running. */
  onFiles(handler: (files: File[]) => void) {
    if (!isNative) return;
    const take = async (list: IncomingFile[]) => {
      const files: File[] = [];
      for (const f of list) {
        try {
          const res = await fetch(Capacitor.convertFileSrc(f.path));
          files.push(new File([await res.blob()], f.name, { type: f.mime ?? '' }));
        } catch (e) {
          console.warn('could not read incoming file', e);
        }
      }
      if (files.length) handler(files);
    };
    void safe(async () => {
      await Glossa.addListener('fileOpened', ({ files }) => void take(files));
      const { files } = await Glossa.takePendingFiles();
      await take(files);
    });
  },
};
