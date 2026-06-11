import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.conductor.app',
  productName: 'Conductor',
  directories: {
    output: 'release'
  },
  files: [
    'dist/**/*',
    'agents.json'
  ],
  win: {
    target: ['nsis', 'portable'],
    icon: 'resources/icon.ico'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
};

export default config;
