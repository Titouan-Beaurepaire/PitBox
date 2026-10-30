import type { Metadata, Viewport } from "next";
import "uplot/dist/uPlot.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "PitLabs Telemetry",
  description: "Télémétrie OBD-II en direct, tableau de bord embarqué et analyse des sessions",
};

export const viewport: Viewport = {
  themeColor: "#0d1014",
  viewportFit: "cover",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
