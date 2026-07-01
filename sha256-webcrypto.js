const { parentPort } = require('node:worker_threads');

const encoder = new TextEncoder();

const calculateSHA256 = async (input) => {
  const data = encoder.encode(input);
  return await globalThis.crypto.subtle.digest("SHA-256", data);
};

const toHexString = (byteArray) => {
  return byteArray.reduce(
    (str, byte) => str + byte.toString(16).padStart(2, "0"),
    "",
  );
};

parentPort.once("message", async (eventData) => {
  const { data, difficulty, threads } = eventData;
  let nonce = eventData.nonce;
  let iterations = 0;

  const requiredZeroBytes = Math.floor(difficulty / 2);
  const isDifficultyOdd = difficulty % 2 !== 0;

  for (;;) {
    const hashBuffer = await calculateSHA256(data + nonce);
    const hashArray = new Uint8Array(hashBuffer);

    let isValid = true;
    for (let i = 0; i < requiredZeroBytes; i++) {
      if (hashArray[i] !== 0) {
        isValid = false;
        break;
      }
    }

    if (isValid && isDifficultyOdd) {
      if (hashArray[requiredZeroBytes] >> 4 !== 0) {
        isValid = false;
      }
    }

    if (isValid) {
      const finalHash = toHexString(hashArray);
      parentPort.postMessage({
        hash: finalHash,
        data,
        difficulty,
        nonce,
      });
      return; // Exit worker
    }

    nonce += threads;
    iterations++;

    /* Truncate the decimal portion of the nonce. This is a bit of an evil bit
     * hack, but it works reliably enough. The core of why this works is:
     *
     * > 13.4 % 1 !== 0
     * true
     * > 13 % 1 !== 0
     * false
     */
    if (nonce % 1 !== 0) {
      nonce = Math.trunc(nonce);
    }
  }
});
