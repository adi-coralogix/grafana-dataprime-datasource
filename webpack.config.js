/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env = {}) => ({
  mode: env.production ? 'production' : 'development',
  target: 'web',
  devtool: env.production ? false : 'eval-source-map',

  entry: './src/module.ts',

  output: {
    filename: 'module.js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'amd',
    publicPath: `public/plugins/coralogix-dataprime-datasource/`,
    clean: true,
  },

  // Grafana provides these at runtime — bundle them externally so the dist stays small
  externals: [
    /^(react|react-dom|react\/jsx-runtime)$/,
    /^@grafana\/.*/,
    /^@emotion\/.*/,
    'lodash',
    'jquery',
    'moment',
  ],

  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader', options: { transpileOnly: true } }],
      },
      {
        test: /\.svg$/,
        type: 'asset/inline',
      },
      {
        test: /\.(png|jpg|gif|webp|ico|eot|ttf|woff|woff2)(\?.*)?$/,
        type: 'asset/resource',
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },

  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'plugin.json', to: '.' },
        { from: 'public/img', to: 'img', noErrorOnMissing: true },
        { from: 'provisioning', to: 'provisioning', noErrorOnMissing: true },
      ],
    }),
  ],
});
