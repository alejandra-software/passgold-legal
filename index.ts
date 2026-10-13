// =====================================================================
// PassGold · Edge Function "eliminar-cuenta"
//
// La llama la app cuando el usuario toca "Eliminar mi cuenta".
// 1. Verifica QUIÉN llama (con su sesión). Solo puede borrar SU cuenta:
//    el id sale del token, nunca de lo que mande la app.
// 2. Borra sus datos con la función SQL eliminar_datos_de_usuario.
// 3. Borra sus fotos de Cloudinary (perfil, portada, vehículos).
// 4. Desliga su celular de OneSignal (deja de recibir avisos).
// 5. Borra el usuario de Supabase Auth (ya no puede iniciar sesión).
//
// Secretos que usa (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  → ya existen solos
//   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET   (Cloudinary → Settings → API Keys)
//   (el cloud name "dg4ofjrwb" ya va escrito abajo, igual que en upload-to-cloudinary)
//   ONESIGNAL_REST_API_KEY  (opcional; si falta, ese paso se salta)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "dg4ofjrwb";
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID") ?? "3b047102-aad6-4e24-8f3b-06309a90334d";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sha1Hex(texto: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(texto));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// https://res.cloudinary.com/<cloud>/image/upload/v1712345/perfiles/abc.jpg → "perfiles/abc"
function publicIdDesdeUrl(url: string, cloud: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "res.cloudinary.com") return null;
    const partes = u.pathname.split("/").filter(Boolean); // [cloud, image, upload, v123, carpeta, archivo.jpg]
    if (partes[0] !== cloud) return null; // solo fotos de NUESTRA cuenta de Cloudinary
    const i = partes.indexOf("upload");
    if (i < 0) return null;
    let resto = partes.slice(i + 1);
    if (resto.length && /^v\d+$/.test(resto[0])) resto = resto.slice(1);
    if (!resto.length) return null;
    return decodeURIComponent(resto.join("/")).replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return null;
  }
}

async function borrarFotoCloudinary(url: string): Promise<boolean> {
  const cloud = CLOUD_NAME;
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const secret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!apiKey || !secret) return false;

  const publicId = publicIdDesdeUrl(url, cloud);
  if (!publicId) return true; // no es una foto de nuestra cuenta (p. ej. la de Google): nada que borrar

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await sha1Hex(`public_id=${publicId}&timestamp=${timestamp}${secret}`);
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("timestamp", timestamp);
  form.append("api_key", apiKey);
  form.append("signature", signature);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: "POST", body: form });
  const body = await resp.json().catch(() => ({}));
  // "ok" = borrada; "not found" = ya no existía. Ambas cuentan como listas.
  return resp.ok && (body.result === "ok" || body.result === "not found");
}

async function desligarOneSignal(userId: string): Promise<boolean> {
  const key = Deno.env.get("ONESIGNAL_REST_API_KEY");
  if (!key) return false;
  const esquema = key.startsWith("os_v2_") ? "Key" : "Basic";
  const resp = await fetch(
    `https://api.onesignal.com/apps/${ONESIGNAL_APP_ID}/users/by/external_id/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: { Authorization: `${esquema} ${key}` } },
  );
  return resp.ok || resp.status === 404;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "Método no permitido" });

  try {
    // Confirmación explícita, para que una llamada accidental no borre nada
    const body = await req.json().catch(() => ({}));
    if (body?.confirmar !== "ELIMINAR") return json(400, { ok: false, error: "Falta la confirmación" });

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { ok: false, error: "Sin sesión" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ¿Quién llama? (un token de "anon" o vencido no tiene usuario → 401)
    const { data: quien, error: errUser } = await admin.auth.getUser(token);
    if (errUser || !quien?.user) return json(401, { ok: false, error: "Sesión no válida" });
    const userId = quien.user.id;

    // 1) Datos en la base (todo o nada)
    const { data: res, error: errSql } = await admin.rpc("eliminar_datos_de_usuario", { p_uid: userId });
    if (errSql) {
      console.error("eliminar_datos_de_usuario falló:", errSql);
      return json(500, { ok: false, error: "No se pudieron borrar los datos", detalle: errSql.message });
    }

    // 2) Fotos (si una falla, se anota para borrarla a mano; no detiene el proceso)
    const fotos: string[] = Array.isArray(res?.fotos) ? res.fotos : [];
    const fotosPendientes: string[] = [];
    for (const url of fotos) {
      try {
        if (!(await borrarFotoCloudinary(url))) fotosPendientes.push(url);
      } catch {
        fotosPendientes.push(url);
      }
    }
    if (fotosPendientes.length) console.warn("Fotos por borrar a mano en Cloudinary:", fotosPendientes);

    // 3) Avisos push
    let pushOk = false;
    try { pushOk = await desligarOneSignal(userId); } catch { pushOk = false; }

    // 4) Cuenta de inicio de sesión
    const { error: errAuth } = await admin.auth.admin.deleteUser(userId);
    if (errAuth) {
      console.error("deleteUser falló:", errAuth);
      return json(500, { ok: false, error: "Se borraron los datos pero no la cuenta de acceso. Intenta de nuevo.", detalle: errAuth.message });
    }

    console.log(`Cuenta ${userId} eliminada`, { ...res, fotosPendientes, pushOk });
    return json(200, {
      ok: true,
      viajes_reasignados: res?.viajes_reasignados ?? 0,
      pasajeros_avisados: res?.pasajeros_avisados ?? 0,
      fotos_pendientes: fotosPendientes.length,
    });
  } catch (e) {
    console.error("eliminar-cuenta:", e);
    return json(500, { ok: false, error: "Error inesperado" });
  }
});
