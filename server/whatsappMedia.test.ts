import { describe, expect, it } from "vitest";
import { baseMime, extensionForMime, isMediaPlaceholderBody, mediaKindForMessageType } from "../shared/whatsappMedia";

describe("mediaKindForMessageType", () => {
  it("image → image; audio e voice → audio; resto → null", () => {
    expect(mediaKindForMessageType("image")).toBe("image");
    expect(mediaKindForMessageType("audio")).toBe("audio");
    expect(mediaKindForMessageType("voice")).toBe("audio");
    expect(mediaKindForMessageType("video")).toBeNull();
    expect(mediaKindForMessageType("document")).toBeNull();
    expect(mediaKindForMessageType("text")).toBeNull();
    expect(mediaKindForMessageType(undefined)).toBeNull();
  });
});

describe("extensionForMime / baseMime", () => {
  it("mapeia os mimes da Meta, ignorando parâmetros", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionForMime("audio/mpeg")).toBe("mp3");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/aac")).toBe("aac");
    expect(extensionForMime("audio/amr")).toBe("amr");
  });
  it("desconhecido/vazio → bin (nunca inventa)", () => {
    expect(extensionForMime("application/x-thing")).toBe("bin");
    expect(extensionForMime(null)).toBe("bin");
    expect(extensionForMime("")).toBe("bin");
  });
  it("baseMime corta parâmetros e normaliza; vazio → null", () => {
    expect(baseMime("Audio/OGG; codecs=opus")).toBe("audio/ogg");
    expect(baseMime("image/jpeg")).toBe("image/jpeg");
    expect(baseMime(null)).toBeNull();
    expect(baseMime("  ")).toBeNull();
  });
});

describe("isMediaPlaceholderBody", () => {
  it("reconhece os marcadores que o webhook grava sem caption", () => {
    expect(isMediaPlaceholderBody("[imagem]")).toBe(true);
    expect(isMediaPlaceholderBody(" [áudio] ")).toBe(true);
    expect(isMediaPlaceholderBody("[mensagem de voz]")).toBe(true);
  });
  it("caption real, vazio ou null não são marcador", () => {
    expect(isMediaPlaceholderBody("foto do carro")).toBe(false);
    expect(isMediaPlaceholderBody("")).toBe(false);
    expect(isMediaPlaceholderBody(null)).toBe(false);
  });
});
