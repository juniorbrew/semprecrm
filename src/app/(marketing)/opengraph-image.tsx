import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "SempreCRM — CRM para WhatsApp";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0d0620",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 600 }}>
          Sempre<span style={{ color: "#a78bfa" }}>CRM</span>
        </div>
        <div style={{ marginTop: 24, fontSize: 32, color: "#c4b5fd" }}>
          CRM para equipes que vendem pelo WhatsApp
        </div>
      </div>
    ),
    { ...size },
  );
}
