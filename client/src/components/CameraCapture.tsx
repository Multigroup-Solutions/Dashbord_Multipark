import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera } from "lucide-react";
import { toast } from "sonner";

// Selfie para o ponto (entrada/saída): câmara frontal, preview e confirmação.
export default function CameraCapture({ onCapture, onCancel }: { onCapture: (base64: string, mimeType: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then(s => { if (active) { setStream(s); if (videoRef.current) videoRef.current.srcObject = s; } })
      .catch(() => toast.error("Não foi possível aceder à câmara"));
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

  const confirm = () => {
    if (!preview) return;
    const base64 = preview.split(",")[1];
    onCapture(base64, "image/jpeg");
  };

  const retake = () => {
    setPreview(null);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then(s => { setStream(s); if (videoRef.current) videoRef.current.srcObject = s; });
  };

  return (
    <div className="space-y-3">
      {!preview ? (
        <>
          <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg border bg-black aspect-video object-cover" />
          <div className="flex gap-2">
            <Button onClick={takePhoto} className="flex-1"><Camera className="w-4 h-4 mr-2" /> Tirar Foto</Button>
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
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
