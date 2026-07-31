import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, Loader2, RefreshCw, Check, Upload } from "lucide-react";
import { toast } from "sonner";

/**
 * Mostrado a quem tem login e está associado a um colaborador SEM foto de perfil.
 * Explica que a foto será o perfil (alterável depois) e é OBRIGATÓRIA para picar
 * o ponto. Pode adiar ("Mais tarde") — a obrigatoriedade é garantida no servidor
 * ao tentar dar entrada no ponto.
 *
 * Duas origens para a foto: câmara (getUserMedia) ou ficheiro do computador.
 * O ficheiro é SEMPRE re-codificado para JPEG num canvas — normaliza o formato
 * (o backend deriva a extensão de `mimeType`), corta o tamanho do payload e
 * neutraliza formatos exóticos. As duas origens partilham o mesmo `preview`,
 * logo o fluxo Repetir / "Usar esta foto" é o mesmo.
 */

// Guarda antes de descodificar: evita rebentar a memória do browser com um
// ficheiro absurdo (uma foto de telemóvel anda pelos 3-12MB).
const MAX_FILE_BYTES = 15 * 1024 * 1024;
// O payload vai em base64 dentro do JSON do tRPC. O express aceita 50mb, mas a
// função serverless (api/index.js no Vercel) corta o body nos ~4.5MB.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.85;
const OUTPUT_MIME = "image/jpeg";

type Preview = { dataUrl: string; mimeType: string };

/** Lê o ficheiro, redimensiona para MAX_DIMENSION e devolve um data-URL JPEG. */
function readImageAsJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) { reject(new Error("Não consegui ler as dimensões da imagem.")); return; }
      const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Não consegui processar a imagem neste navegador.")); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(OUTPUT_MIME, JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Formato de imagem não suportado. Tenta JPG ou PNG."));
    };
    img.src = objectUrl;
  });
}

/** Tamanho real (bytes) de um payload base64, sem o materializar. */
function base64Bytes(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}

export default function ProfilePhotoPrompt({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const setOpen = onOpenChange;
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // O stream vive também numa ref: a limpeza no unmount corre uma só vez e não
  // pode depender do valor de `stream` capturado no primeiro render.
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const upload = trpc.rh.uploadMyPhoto.useMutation({
    onSuccess: () => {
      toast.success("Foto de perfil guardada!");
      utils.auth.me.invalidate();
      stopCamera();
      setPreview(null);
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const close = () => {
    stopCamera();
    setPreview(null);
    setCameraFailed(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) { stopCamera(); return; }
    if (preview) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setCameraFailed(true);
      return;
    }
    let active = true;
    media
      .getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((s) => {
        if (!active) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s;
        setStream(s);
        setCameraFailed(false);
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => {
        if (!active) return;
        setCameraFailed(true);
        toast.error("Não consegui aceder à câmara. Verifica as permissões ou carrega uma foto do computador.");
      });
    return () => { active = false; };
  }, [open, preview, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]); // cleanup ao desmontar

  const capture = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c || !v.videoWidth || !v.videoHeight) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    setPreview({ dataUrl: c.toDataURL(OUTPUT_MIME, JPEG_QUALITY), mimeType: OUTPUT_MIME });
    stopCamera();
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // permite voltar a escolher o mesmo ficheiro
    if (!file) return;

    // SVG entra em `image/*` mas não tem dimensões intrínsecas fiáveis (e não
    // faz sentido como foto de perfil).
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      toast.error("Escolhe um ficheiro de imagem (JPG, PNG ou WEBP).");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.error(`A imagem é demasiado grande (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
      return;
    }

    setProcessingFile(true);
    try {
      const dataUrl = await readImageAsJpeg(file);
      const base64 = dataUrl.split(",")[1] ?? "";
      if (!base64) throw new Error("Não consegui processar a imagem.");
      if (base64Bytes(base64) > MAX_UPLOAD_BYTES) throw new Error("A imagem continua demasiado grande depois de processada.");
      stopCamera();
      setPreview({ dataUrl, mimeType: OUTPUT_MIME });
    } catch (err) {
      console.error("[ProfilePhotoPrompt] falha a processar o ficheiro escolhido", err);
      toast.error(err instanceof Error ? err.message : "Não consegui ler a imagem.");
    } finally {
      setProcessingFile(false);
    }
  };

  const confirm = () => {
    if (!preview) return;
    const base64 = preview.dataUrl.split(",")[1];
    if (!base64) { toast.error("Foto inválida. Tenta novamente."); return; }
    upload.mutate({ fileBase64: base64, mimeType: preview.mimeType });
  };

  const retake = () => { setPreview(null); };

  const busy = upload.isPending || processingFile;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !upload.isPending) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Camera className="w-5 h-5 text-primary" /> Foto de perfil</DialogTitle>
          <DialogDescription>
            Vamos tirar uma foto para o teu perfil. Podes trocá-la mais tarde, mas é
            <strong> obrigatória para picar o ponto</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          <div className="w-full aspect-[4/3] bg-muted rounded-lg overflow-hidden flex items-center justify-center">
            {preview ? (
              <img src={preview.dataUrl} alt="pré-visualização" className="w-full h-full object-cover" />
            ) : cameraFailed ? (
              <div className="flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                <Camera className="w-8 h-8" />
                A câmara não está disponível. Carrega uma foto do computador.
              </div>
            ) : (
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFilePicked}
          />

          {!preview ? (
            <div className="flex flex-col gap-2 w-full">
              {!cameraFailed && (
                <Button onClick={capture} disabled={!stream || busy}>
                  <Camera className="w-4 h-4 mr-2" /> Tirar foto
                </Button>
              )}
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
                {processingFile ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                Carregar do computador
              </Button>
            </div>
          ) : (
            <div className="flex gap-2 w-full">
              <Button variant="outline" className="flex-1" onClick={retake} disabled={busy}>
                <RefreshCw className="w-4 h-4 mr-2" /> Repetir
              </Button>
              <Button className="flex-1" onClick={confirm} disabled={busy}>
                {upload.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                Usar esta foto
              </Button>
            </div>
          )}

          <button
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            onClick={close}
            disabled={upload.isPending}
          >
            Mais tarde
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
