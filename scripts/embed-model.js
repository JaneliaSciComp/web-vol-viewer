const fs = require('fs');

const model = fs.readFileSync('src/peak_model.onnx');
const b64 = model.toString('base64');
fs.writeFileSync('dist/peakModelData.js',
  `export default "data:application/octet-stream;base64,${b64}";\n`);
