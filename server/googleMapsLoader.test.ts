import { beforeEach, describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({ setOptions: vi.fn(), importLibrary: vi.fn() }));
vi.mock("@googlemaps/js-api-loader", () => loader);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  loader.importLibrary.mockImplementation(async (name: string) => ({ name }));
});

describe("carregamento partilhado do Google Maps", () => {
  it("não faz pedidos sem chave", async () => {
    const { loadGoogleMaps } = await import("../client/src/lib/googleMaps");
    await expect(loadGoogleMaps(" ")).rejects.toThrow();
    expect(loader.setOptions).not.toHaveBeenCalled();
    expect(loader.importLibrary).not.toHaveBeenCalled();
  });

  it("configura uma vez entre montagens concorrentes e carrega só mapa e marcadores", async () => {
    const { loadGoogleMaps } = await import("../client/src/lib/googleMaps");
    const results = await Promise.all([loadGoogleMaps("test-browser-key"), loadGoogleMaps("test-browser-key")]);
    expect(loader.setOptions).toHaveBeenCalledTimes(1);
    expect(loader.setOptions).toHaveBeenCalledWith({ key: "test-browser-key", v: "quarterly", language: "pt-PT", region: "PT" });
    expect(loader.importLibrary.mock.calls.map(([name]) => name)).toEqual(["maps", "marker", "maps", "marker"]);
    expect(results[0]).toEqual({ maps: { name: "maps" }, marker: { name: "marker" } });
  });

  it("propaga falhas de rede e permite voltar a pedir as bibliotecas", async () => {
    const { loadGoogleMaps } = await import("../client/src/lib/googleMaps");
    loader.importLibrary.mockRejectedValueOnce(new Error("network"));
    await expect(loadGoogleMaps("test-browser-key")).rejects.toThrow("network");
    await expect(loadGoogleMaps("test-browser-key")).resolves.toHaveProperty("maps");
    expect(loader.setOptions).toHaveBeenCalledTimes(1);
  });
});
