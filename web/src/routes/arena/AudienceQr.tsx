import { QRCodeSVG } from 'qrcode.react';

const QR_SIZE = 200;

/** Join QR for the audience. The QR sits on a light chip so it scans on the dark projector theme. */
export function AudienceQr() {
  const { origin, host } = window.location;
  return (
    <section className="flex flex-col items-center gap-3 rounded-card border border-line bg-surface-raised p-6 text-center text-ink">
      <h2 className="title text-ink">Scan to fight the AI Agent</h2>
      <div data-theme="light" className="rounded-chip bg-surface-raised p-3 text-ink">
        <QRCodeSVG value={`${origin}/`} size={QR_SIZE} fgColor="currentColor" bgColor="transparent" />
      </div>
      <p className="data break-all text-ink-muted">{host}</p>
      <p className="label text-ink-muted">Open this link in your browser</p>
    </section>
  );
}
