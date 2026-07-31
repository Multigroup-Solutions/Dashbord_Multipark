import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Upload } from "lucide-react";
import { toast } from "sonner";

// Selfie para o ponto (entrada/saída): câmara frontal, preview e confirmação.
// PDAs/telemóveis problemáticos: (1) sem câmara frontal → tenta qualquer
// câmara; (2) getUserMedia bloqueado/indisponível → fallback para escolher/
// tirar foto via input de ficheiro (capture) — resolve o "não deixa fazer
// upload da foto" nos PDAs.
export default function CameraCapture({ onCapture, onCancel }: { onCapture: (base64: string, mimeType: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);

  const openCamera = async (): Promise<MediaStream | null> => {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    try {
      // 1ª escolha: câmara frontal (selfie)
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    } catch {
      try {
        // PDAs sem câmara frontal (ou driver esquisito): qualquer câmara serve
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch {
        return null;
      }
    }
  };

  useEffect(() => {
    let active = true;
    openCamera().then(s => {
      if (!active) { s?.getTracks().forEach(t => t.stop()); return; }
      if (s) { setStream(s); if (videoRef.current) videoRef.current.srcObject = s; }
      else {
        setCameraFailed(true);
        toast.error("Não foi possível aceder à câmara — usa o botão de escolher foto");
      }
    });
    return () => { active = false; stream?.getTracks().forEach(t => t.stop()); };
  }, []);

  const takePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    setPreview(dataUrl);
    stream?.getTracks().forEach(t => t.stop());
  };

  // Fallback: foto vinda do input de ficheiro (a app da câmara do próprio
  // telemóvel via capture, ou a galeria). Redimensiona para não rebentar o
  // payload tRPC (fotos de PDA podem vir com 8-12MB).
  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) { URL.revokeObjectURL(url); return; }
      const MAX = 1280;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      setPreview(canvas.toDataURL("image/jpeg", 0.8));
      stream?.getTracks().forEach(t => t.stop());
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { toast.error("Não foi possível ler a imagem"); URL.revokeObjectURL(url); };
    img.src = url;
  };

  const confirm = () => {
    if (!preview) return;
    const base64 = preview.split(",")[1];
    onCapture(base64, "image/jpeg");
  };

  const retake = () => {
    setPreview(null);
    openCamera().then(s => {
      if (s) { setCameraFailed(false); setStream(s); if (videoRef.current) videoRef.current.srcObject = s; }
      else setCameraFailed(true);
    });
  };

  return (
    <div className="space-y-3">
      {!preview ? (
        <>
          {!cameraFailed && (
            <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg border bg-black aspect-video object-cover" />
          )}
          {cameraFailed && (
            <div className="w-full rounded-lg border bg-muted aspect-video flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground p-4 text-center">
              <Camera className="w-8 h-8" />
              A câmara não está disponível neste aparelho/navegador.
              Usa "Escolher foto" — abre a câmara do próprio telemóvel.
            </div>
          )}
          <div className="flex gap-2">
            {!cameraFailed && (
              <Button onClick={takePhoto} className="flex-1"><Camera className="w-4 h-4 mr-2" /> Tirar Foto</Button>
            )}
            <Button onClick={() => fileRef.current?.click()} variant={cameraFailed ? "default" : "outline"} className={cameraFailed ? "flex-1" : ""}>
              <Upload className="w-4 h-4 mr-2" /> Escolher foto
            </Button>
            <Button onClick={onCancel} variant="outline">Cancelar</Button>
          </div>
        </>
      ) : (
        <>
          <img src={preview} alt="Preview" className="w-full rounded-lg border aspect-video object-cover" />
          <div className="flex gap-2">
            <Button onClick={confirm} className="flex-1 bg-green-600 hover:bg-green-700">Confirmar</Button>
            <Button onClick={retake} variant="outline">Repetir</Button>
            <Button onClick={onCancel} variant="outline">Cancelar</Button>
          </div>
        </>
      )}
      <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden" onChange={onFilePicked} />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
