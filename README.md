# CORREXO

Análisis biomecánico de carrera (trail) por video + IA. Un producto de TodoTrail.

**Live:** https://correxo-production.up.railway.app

## Qué hace

- **Landing** que vende el servicio (hero con pose sobre corredor real, cómo funciona, qué mide, ciencia, precio).
- **Motor de análisis on-device** (BlazePose en el navegador): cadencia, oscilación vertical y overstride (perfil) + caída pélvica y valgo (espaldas), en bandas, con compuerta de calidad. El screening completo requiere las **dos tomas**.
- **Cobro** por reporte PDF vía Stripe Checkout (backend seguro; la clave secreta nunca llega al navegador).
- **Backend de piloto**: modo Operador (PIN) para registrar corredores, consentimiento, revisión médica (con concordancia), guardar análisis + los 2 videos, listar y exportar CSV. PDF del corredor con firma del médico, sin pago.

## Estructura

```
index.html      frontend (landing + app + modo operador)
server.js       Express: estático + Stripe + API del piloto
package.json    deps: express, stripe, pg, multer
```

## Infra (Railway)

- Servicio **correxo** (este código) con un **volumen** montado en `/data` (videos en `/data/videos`).
- Servicio **Postgres** (tabla `analyses`, se crea sola al arrancar).
- Variables: ver `.env.example`. `DATABASE_URL` es una referencia a `${{Postgres.DATABASE_URL}}`.

## Deploy

```bash
railway link --project 8f8efb3e-2cd0-457f-9785-9d08fe2ba53e --service correxo --environment production
railway up --detach --service correxo
```

## API del piloto (todas requieren header `x-operator-pin`, salvo login)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/operator/login` | valida el PIN |
| POST | `/api/analyses` | crea un análisis (datos + métricas + revisión médica) |
| POST | `/api/analyses/:id/video?view=perfil\|trasera` | sube un video |
| GET | `/api/analyses` | lista |
| GET | `/api/analyses/:id` | detalle |
| GET | `/api/analyses/:id/video/:view` | descarga un video |
| DELETE | `/api/analyses/:id` | borra análisis + videos |
| GET | `/api/export.csv` | export (métricas + concordancia) |
| GET | `/api/health` | estado de DB/volumen/PIN |

## Pendiente

- Cargar claves de Stripe + crear el Price para habilitar el cobro público.
- Validar el motor con videos reales y calibrar umbrales con un kinesiólogo (el piloto con médico es la vía).
- Encuadre legal del consentimiento (revisión salud/legal AR).
- Fine-tuning de un modelo propio de running (foso de largo plazo).
