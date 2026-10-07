/// <reference types="google.maps" />
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

let configured = false;

// Partilhado entre montagens: atualizar o GPS não volta a carregar a API.
export async function loadGoogleMaps(apiKey: string) {
  if (!apiKey.trim()) throw new Error("Google Maps sem chave configurada");
  if (!configured) {
    setOptions({ key: apiKey, v: "quarterly", language: "pt-PT", region: "PT" });
    configured = true;
  }
  const [maps, marker] = await Promise.all([
    importLibrary("maps"),
    importLibrary("marker"),
  ]);
  return { maps, marker };
}
