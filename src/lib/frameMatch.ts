/** Pearson correlation of two 32×32 grayscale buffers. A flat buffer has no correlation. */
export function correlateGrayBuffers(left: Buffer, right: Buffer): number | undefined {
  if (left.length < 1024 || right.length < 1024) return undefined;
  let meanLeft = 0;
  let meanRight = 0;
  for (let index = 0; index < 1024; index += 1) {
    meanLeft += left[index];
    meanRight += right[index];
  }
  meanLeft /= 1024;
  meanRight /= 1024;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < 1024; index += 1) {
    const x = left[index] - meanLeft;
    const y = right[index] - meanRight;
    numerator += x * y;
    leftSquare += x * x;
    rightSquare += y * y;
  }
  if (leftSquare === 0 || rightSquare === 0) return undefined;
  return Math.round((numerator / Math.sqrt(leftSquare * rightSquare)) * 1000) / 1000;
}
