import type { MetadataRoute } from "next";

// Permet d'ajouter le dash à l'écran d'accueil du téléphone : il s'ouvre alors en plein écran, en paysage
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PitLabs Dash",
    short_name: "PitLabs",
    start_url: "/dash",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#000000",
    theme_color: "#0d1014",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
