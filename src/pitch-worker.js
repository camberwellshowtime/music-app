let nsdfBuf = null

function detectPitch(buf, sampleRate) {
  const n = buf.length
  const minPeriod = Math.floor(sampleRate / 700)
  const maxPeriod = Math.floor(sampleRate / 80)

  if (!nsdfBuf || nsdfBuf.length < maxPeriod) nsdfBuf = new Float32Array(maxPeriod)

  for (let tau = minPeriod; tau < maxPeriod; tau += 2) {
    let acf = 0, norm = 0
    for (let i = 0; i < n - tau; i++) {
      acf += buf[i] * buf[i + tau]
      norm += buf[i] * buf[i] + buf[i + tau] * buf[i + tau]
    }
    nsdfBuf[tau] = norm > 0 ? 2 * acf / norm : 0
  }

  const THRESHOLD = 0.8
  let bestTau = -1, bestVal = THRESHOLD, inPeak = false
  for (let tau = minPeriod; tau < maxPeriod; tau += 2) {
    if (!inPeak && nsdfBuf[tau] > THRESHOLD) inPeak = true
    if (inPeak) {
      if (nsdfBuf[tau] > bestVal) { bestVal = nsdfBuf[tau]; bestTau = tau }
      if (nsdfBuf[tau] < 0) { inPeak = false; break }
    }
  }
  if (bestTau < 0) return null

  const y0 = nsdfBuf[Math.max(minPeriod, bestTau - 1)]
  const y1 = nsdfBuf[bestTau]
  const y2 = nsdfBuf[Math.min(maxPeriod - 1, bestTau + 1)]
  const denom = 2 * (2 * y1 - y0 - y2)
  return sampleRate / (denom !== 0 ? bestTau + (y0 - y2) / denom : bestTau)
}

self.onmessage = ({ data: { buf, sampleRate } }) => {
  self.postMessage({ hz: detectPitch(buf, sampleRate), ts: Date.now() })
}
