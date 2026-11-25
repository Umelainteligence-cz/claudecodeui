/**
 * Kryton PDF overlay (E474): print CSS added to the transcript HTML before it is printed.
 *
 * The transcript components are drawn for a fixed-height app shell with scroll areas; on
 * paper every such box must grow to its content, or the PDF stops at the first screenful.
 * `content-visibility` is already switched off by the upstream builder.
 */
export const PRINT_CSS = `
@page { size: A4; margin: 15mm 12mm; }
:root { color-scheme: light; }
html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
[class*="max-h-"], [class*="overflow-"], [class*="h-screen"], [class*="h-full"] {
  max-height: none !important; overflow: visible !important;
}
.sticky, .fixed { position: static !important; }
h1, h2, h3 { break-after: avoid; }
pre, table, img, figure { break-inside: avoid; }
pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere; }
pre { overflow: visible !important; max-height: none !important; }
pre, pre * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print {
  .chat-export-shell { max-width: none; padding: 0; }
}
`;
