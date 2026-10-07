// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({ loadGoogleMaps: vi.fn() }));
vi.mock("../client/src/lib/googleMaps", () => loader);
vi.mock("../client/src/components/ui/button", () => ({ Button: "button" }));

class Events {
  listeners = new Map<string, () => void>();
  addListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
}
class FakeMap extends Events {
  static instances: FakeMap[] = [];
  fitBounds = vi.fn();
  setCenter = vi.fn();
  setZoom = vi.fn();
  getZoom = () => 9;
  constructor() { super(); FakeMap.instances.push(this); }
}
class FakeMarker extends Events {
  static instances: FakeMarker[] = [];
  map: unknown;
  position: unknown;
  title = "";
  content?: HTMLElement;
  constructor(options: { map: unknown; position: unknown }) {
    super(); this.map = options.map; this.position = options.position;
    FakeMarker.instances.push(this);
  }
}
class FakePopup extends Events {
  static instances: FakePopup[] = [];
  setContent = vi.fn();
  open = vi.fn();
  close = vi.fn();
  constructor() { super(); FakePopup.instances.push(this); }
}
class FakeTraffic {
  static instances: FakeTraffic[] = [];
  setMap = vi.fn();
  constructor() { FakeTraffic.instances.push(this); }
}

let Component: typeof import("../client/src/components/maps/ZelloGoogleMap").ZelloGoogleMap;
let root: Root;
let host: HTMLDivElement;
const driver = {
  username: "pda-1", displayName: "PDA 1", name: "Condutor", color: "#10b981",
  latitude: 38.77, longitude: -9.13, speed: 20, batteryLevel: 80, lastReportDelay: 10,
};
const maps = { Map: FakeMap, TrafficLayer: FakeTraffic, InfoWindow: FakePopup };

beforeAll(async () => {
  vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-browser-key");
  vi.stubEnv("VITE_GOOGLE_MAPS_MAP_ID", "test-map-id");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Component = (await import("../client/src/components/maps/ZelloGoogleMap")).ZelloGoogleMap;
});
beforeEach(() => {
  vi.clearAllMocks();
  FakeMap.instances = []; FakeMarker.instances = []; FakePopup.instances = []; FakeTraffic.instances = [];
  vi.stubGlobal("google", { maps: {
    ...maps, marker: { AdvancedMarkerElement: FakeMarker },
    event: { clearInstanceListeners: vi.fn(), addListenerOnce: vi.fn() },
  } });
  loader.loadGoogleMaps.mockResolvedValue({ maps, marker: {} });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render(drivers = [driver]) {
  await act(async () => { root.render(createElement(Component, { drivers })); });
}

describe("mapa Google dos condutores", () => {
  it("atualiza o mesmo marcador e conserva a vista durante o polling", async () => {
    await render();
    const map = FakeMap.instances[0];
    const marker = FakeMarker.instances[0];
    const popup = FakePopup.instances[0];
    await act(async () => { marker.listeners.get("click")?.(); });
    await render([{ ...driver, latitude: 38.8, speed: 70, name: "Check-in atualizado" }]);
    expect(FakeMap.instances).toHaveLength(1);
    expect(FakeMarker.instances).toHaveLength(1);
    expect(marker.position).toEqual({ lat: 38.8, lng: -9.13 });
    expect(marker.title).toBe("Check-in atualizado");
    expect(map.setCenter).toHaveBeenCalledTimes(1);
    expect(map.setZoom).toHaveBeenCalledTimes(1);
    expect(popup.setContent.mock.lastCall?.[0].textContent).toContain("70 km/h");
  });

  it("trata nomes externos como texto no marcador e nos detalhes", async () => {
    const name = '<img src=x onerror="alert(1)">';
    await render([{ ...driver, name }]);
    const marker = FakeMarker.instances[0];
    expect(marker.content?.textContent).toContain(name);
    expect(marker.content?.querySelector("img")).toBeNull();
    marker.listeners.get("click")?.();
    const content = FakePopup.instances[0].setContent.mock.lastCall?.[0] as HTMLElement;
    expect(content.textContent).toContain(name);
    expect(content.querySelector("img")).toBeNull();
  });

  it("remove condutores ausentes e fecha os detalhes selecionados", async () => {
    await render();
    const marker = FakeMarker.instances[0];
    marker.listeners.get("click")?.();
    await render([]);
    expect(marker.map).toBeNull();
    expect(FakePopup.instances[0].close).toHaveBeenCalled();
  });

  it("limpa marcadores, trânsito e eventos quando o separador desmonta", async () => {
    await render();
    await act(async () => { root.unmount(); });
    expect(FakeMarker.instances[0].map).toBeNull();
    expect(FakeTraffic.instances[0].setMap).toHaveBeenLastCalledWith(null);
    expect(FakePopup.instances[0].close).toHaveBeenCalled();
    expect(google.maps.event.clearInstanceListeners).toHaveBeenCalledWith(FakeMap.instances[0]);
  });

  it("não cria um mapa se a API terminar de carregar depois de sair do separador", async () => {
    let resolve!: (value: unknown) => void;
    loader.loadGoogleMaps.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => { root.unmount(); resolve({ maps }); });
    expect(FakeMap.instances).toHaveLength(0);
  });

  it("apresenta erro de autorização, em vez de um mapa vazio", async () => {
    await render();
    await act(async () => window.gm_authFailure?.());
    expect(host.textContent).toContain("Não foi possível carregar o Google Maps");
    expect(host.textContent).toContain("Tentar novamente");
  });
});
