module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true,"marker":"raw-node-handler"}');
};
