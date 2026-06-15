import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.conductor.workbench',
  productName: 'conductor',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'dist/**/*',
    'out/**/*',
    'agents.json'
  ],
  npmRebuild: false,
  win: {
    icon: 'src/renderer/logo.png',
    target: ['nsis', 'portable'],
    artifactName: '${name}-setup-${version}.${ext}',
  },
  portable: {
    artifactName: '${name}-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${name}-setup-${version}.${ext}',
  }
};

export default config;
