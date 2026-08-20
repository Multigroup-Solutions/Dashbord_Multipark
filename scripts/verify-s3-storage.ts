/**
 * Verificação end-to-end do bucket S3 do dashboard ATRAVÉS da abstração
 * server/storage.ts — exatamente o caminho que a produção usa.
 *
 * Correr da raiz do dashboard:  ./node_modules/.bin/tsx scripts/verify-s3-storage.ts
 * Lê AWS_S3_REGION / AWS_S3_BUCKET_NAME / AWS_S3_ACCESS_KEY /
 * AWS_S3_SECRET_ACCESS_KEY do .env; falha se não estiverem definidas.
 * (O storage.ts ainda aceita os nomes antigos AWS_ACCESS_KEY /
 * AWS_SECRET_ACCESS_KEY como fallback, mas este script exige os novos —
 * é a configuração que a produção tem de ter.)
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });
delete process.env.BLOB_READ_WRITE_TOKEN; // forçar o ramo S3

const required = [
  "AWS_S3_REGION",
  "AWS_S3_BUCKET_NAME",
  "AWS_S3_ACCESS_KEY",
  "AWS_S3_SECRET_ACCESS_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Envs em falta no .env: ${missing.join(", ")}`);
  process.exit(1);
}
const bucket = process.env.AWS_S3_BUCKET_NAME!;
const region = process.env.AWS_S3_REGION!;

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  // import dinâmico DEPOIS do dotenv, para o storage ver as envs
  const { storagePut, storageGet, storageDelete, storagePresignPut } = await import("../server/storage");

  const key = "verify/hello.txt";
  const body = `bucket verification ${new Date().toISOString()}`;

  const put = await storagePut(key, body, "text/plain");
  check("storagePut devolve key+url", put.key === key && put.url.includes(bucket), put.url);

  const anonGet = await fetch(put.url);
  const gotBody = anonGet.ok ? await anonGet.text() : "";
  check("GET anónimo 200 + conteúdo igual", anonGet.status === 200 && gotBody === body, `status=${anonGet.status}`);

  const got = await storageGet(key);
  check("storageGet existente → url", got.url.length > 0, got.url);

  const missingObj = await storageGet("verify/does-not-exist.bin");
  check('storageGet inexistente → url ""', missingObj.url === "");

  const anonList = await fetch(`https://${bucket}.s3.${region}.amazonaws.com/`);
  check("LIST anónimo bloqueado (403)", anonList.status === 403, `status=${anonList.status}`);

  const presignKey = "verify/presigned-upload.txt";
  const presign = await storagePresignPut(presignKey, "text/plain", 60);
  const presignBody = "uploaded via presigned url";
  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: presignBody,
  });
  check("PUT pré-assinado aceite", putRes.ok, `status=${putRes.status}`);
  const presignGet = await fetch(presign.url);
  check(
    "objeto pré-assinado lê-se publicamente",
    presignGet.status === 200 && (await presignGet.text()) === presignBody,
    `status=${presignGet.status}`
  );

  await storageDelete(put.url); // forma mais difícil: URL absoluta
  const afterDel = await fetch(put.url);
  check("delete por URL → objeto removido", afterDel.status === 403 || afterDel.status === 404, `status=${afterDel.status}`);

  await storageDelete(presignKey); // forma simples: key
  const afterDel2 = await fetch(presign.url);
  check("delete por key → objeto removido", afterDel2.status === 403 || afterDel2.status === 404, `status=${afterDel2.status}`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("VERIFICATION CRASHED:", err);
  process.exit(1);
});
