// A portable bundle must start the image it ships, regardless of source defaults.
export function releaseCompose(source, image) {
  const imageLines = source.match(/^    image:.*$/gm) || [];
  const buildLines = source.match(/^    build:.*$/gm) || [];
  if (imageLines.length !== 1 || buildLines.length !== 1 || buildLines[0].trim() !== "build: .") {
    throw new Error("Expected one studio image and a 'build: .' entry in compose.yaml");
  }
  return source
    .replace(/^    image:.*$/m, () => `    image: ${JSON.stringify(image)}`)
    .replace(/^    build: \.\r?\n/m, "");
}
