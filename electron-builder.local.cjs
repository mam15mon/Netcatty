const base = require('./electron-builder.config.cjs');

module.exports = {
  ...base,
  win: {
    ...(base.win || {}),
    signAndEditExecutable: false,
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
};
