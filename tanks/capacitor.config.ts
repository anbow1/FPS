import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.anbow1.tanks',
  appName: 'Tanks',
  webDir: 'dist',
  backgroundColor: '#0d0f11',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
