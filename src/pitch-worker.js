// Radix-2 in-place DFT (negative-exponent convention).
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wRe = Math.cos(ang), wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0
      for (let j = 0; j < (len >> 1); j++) {
        const u = i + j, v = u + (len >> 1)
        const vRe = re[v] * curRe - im[v] * curIm
        const vIm = re[v] * curIm + im[v] * curRe
        re[v] = re[u] - vRe; im[v] = im[u] - vIm
        re[u] += vRe; im[u] += vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p }

// Persistent buffers — allocated once, reused every call.
let fftRe = null, fftIm = null, prefixSq = null

function detectPitch(buf, sampleRate) {
  const n = buf.length
  const minPeriod = Math.floor(sampleRate / 700)
  const maxPeriod = Math.floor(sampleRate / 80)

  // Zero-pad to 2n to avoid circular-correlation aliasing.
  const fftSize = nextPow2(2 * n)
  if (!fftRe || fftRe.length < fftSize) {
    fftRe    = new Float64Array(fftSize)
    fftIm    = new Float64Array(fftSize)
    prefixSq = new Float64Array(n + 1)
  }

  // O(n) prefix sums of squares — lets us compute the NSDF denominator
  // m[tau] = prefixSq[n-tau] + prefixSq[n] - prefixSq[tau]  in O(1) per tau.
  prefixSq[0] = 0
  for (let i = 0; i < n; i++) prefixSq[i + 1] = prefixSq[i] + buf[i] * buf[i]

  // Autocorrelation via FFT:
  //   ACF[tau] = real(IFFT(|FFT(x_padded)|²))[tau]
  // For real power spectrum P, real(IFFT(P)) = FFT(P).re / fftSize
  // (conjugate-trick identity; only the real part matters since ACF is real).
  for (let i = 0; i < n; i++) { fftRe[i] = buf[i]; fftIm[i] = 0 }
  for (let i = n; i < fftSize; i++) { fftRe[i] = 0; fftIm[i] = 0 }
  fft(fftRe, fftIm)
  for (let i = 0; i < fftSize; i++) {
    fftRe[i] = fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i]  // |X|²
    fftIm[i] = 0
  }
  fft(fftRe, fftIm)
  // fftRe[tau] is now FFT(P).re[tau] = fftSize × ACF[tau]

  const nsdfAt = (tau) => {
    const m = prefixSq[n - tau] + prefixSq[n] - prefixSq[tau]
    return m > 0 ? 2 * fftRe[tau] / (m * fftSize) : 0
  }

  const THRESHOLD = 0.8
  let bestTau = -1, bestVal = THRESHOLD, inPeak = false
  for (let tau = minPeriod; tau < maxPeriod; tau += 2) {
    const nsdf = nsdfAt(tau)
    if (!inPeak && nsdf > THRESHOLD) inPeak = true
    if (inPeak) {
      if (nsdf > bestVal) { bestVal = nsdf; bestTau = tau }
      if (nsdf < 0) { inPeak = false; break }
    }
  }
  if (bestTau < 0) return null

  // Parabolic interpolation for sub-sample accuracy.
  const y0 = nsdfAt(Math.max(minPeriod, bestTau - 1))
  const y1 = nsdfAt(bestTau)
  const y2 = nsdfAt(Math.min(maxPeriod - 1, bestTau + 1))
  const denom = 2 * (2 * y1 - y0 - y2)
  return sampleRate / (denom !== 0 ? bestTau + (y0 - y2) / denom : bestTau)
}

self.onmessage = ({ data: { buf, sampleRate } }) => {
  self.postMessage({ hz: detectPitch(buf, sampleRate), ts: Date.now() })
}
