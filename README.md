# 🤖 Inversiones Bot - Trading Automático en Binance

Un bot de trading automático construido con **NestJS** y **TypeScript**. Este bot opera en Binance con el par `BTC/USDT` utilizando la estrategia del indicador **RSI (Relative Strength Index)** y reporta toda su actividad a través de **Telegram**. Además, persiste el registro de las operaciones en una base de datos **PostgreSQL**.

## 🚀 Funcionalidades Principales

### 📈 Estrategia de Trading (RSI)
- Analiza periódicamente el mercado (por defecto cada 1 hora) utilizando velas de temporalidad de 1H para el par **BTC/USDT**.
- **Señal de Compra**: Si no hay una operación abierta en el momento y el valor del **RSI es menor a 35** (indicando sobreventa), el bot ejecuta una orden de compra a precio de mercado (`MARKET`) utilizando un monto fijo de **15 USDT**.
- **Señal de Venta**: Si existe una posición abierta, el bot la venderá en su totalidad a valor de mercado si se cumple alguna de estas dos condiciones:
  - El **RSI supera 65** (indicando sobrecompra).
  - La **ganancia neta es igual o mayor al 2.0%** (Take profit por porcentaje).

### 📱 Integración con Telegram (Comandos)
El bot se comunica en tiempo real con un chat de un usuario/grupo de Telegram. Te permite interactuar y consultar el estado de tu cuenta mediante los siguientes comandos:
- `/status`: Muestra un panel de resumen con tu saldo actual en Spot (USDT), la cantidad de operaciones cerradas históricamente, la ganancia total acumulada y el estado de la posición actual (ya sea una orden de compra activa con su precio de entrada, o simplemente en espera de una oportunidad).
- `/rsi`: Consulta bajo demanda las velas de Binance y te devuelve el valor exacto del RSI de BTC en la temporalidad de 1H en ese instante.

### 📊 Reportes y Notificaciones Automáticas
- **Notificaciones de Operación**: Genera alertas inmediatas a Telegram cada vez que se ejecuta una compra o una venta con éxito, informando el precio de ejecución, el monto y la ganancia obtenida en caso de venta.
- **Resumen Diario Automático**: Todos los días a las **09:00 AM** (Hora Argentina), el bot recaba información del mercado y tu billetera, enviando un resumen que incluye:
  - Tu saldo actual en USDT.
  - El precio actual del Bitcoin.
  - El RSI actual de 1H.
  - Una breve sugerencia o alerta visual basada en el nivel de RSI (ej. mercado estable vs. alerta de compra).

### 💾 Persistencia de Datos e Historial
- Cada operación queda registrada de forma permanente en una base de datos relacional **PostgreSQL** en la tabla `trading_operaciones`.
- El bot registra el `ticker`, `precio_compra`, `precio_venta`, `monto_usdt`, el estado actual de la orden (`ABIERTA` / `CERRADA`), y la `ganancia_neta` obtenida en cada iteración.
- Previene tener múltiples operaciones abiertas al mismo tiempo consultando la base de datos antes de comprar.

## 🛠️ Stack Tecnológico

- **[NestJS](https://nestjs.com/)**: Framework escalable para el backend en Node.js.
- **[@binance/connector-typescript](https://github.com/binance/binance-connector-typescript)**: Integración oficial y tipada para la API Spot de Binance.
- **[Telegraf](https://telegraf.js.org/)**: SDK moderno para la creación de bots de Telegram en Node.js.
- **[TechnicalIndicators](https://github.com/anandanand84/technicalindicators)**: Paquete para el cálculo matemático del indicador financiero RSI.
- **[PostgreSQL (pg)](https://node-postgres.com/)**: Motor de base de datos relacional para guardar operaciones de forma segura.
- **Docker & Docker Compose**: Contenerización lista para entornos de producción.

## ⚙️ Configuración (Variables de Entorno)

Para poner en marcha el bot, se deben definir las siguientes variables en un archivo `.env` en la raíz del proyecto:

```env
# Configuración de Base de Datos PostgreSQL
DB_HOST=localhost
DB_USER=tu_usuario_db
DB_PASSWORD=tu_password_db
DB_NAME=db_gastos

# Claves de la API de Binance (necesitan permisos de Spot Trading habilitados)
BINANCE_API_KEY=tu_api_key_de_binance
BINANCE_SECRET_KEY=tu_secret_key_de_binance

# Credenciales de Telegram
TELEGRAM_TOKEN=tu_token_del_bot_de_telegram
TELEGRAM_CHAT_ID=tu_chat_id_donde_el_bot_enviara_mensajes
```

## 🐳 Despliegue en Producción (Docker)

El repositorio incluye un `Dockerfile` y un `docker-compose.yml` listos para ser desplegados. Una característica de la configuración actual en Compose es que el bot (`bot-trading`) se adhiere directamente a la red de un contenedor de Postgres existente llamado `postgres_prod` (`network_mode: 'container:postgres_prod'`), lo que permite conectarse a la DB como si fuera local (`localhost`).

Para levantar el bot en un entorno de producción (en segundo plano):
```bash
docker-compose up -d --build
```
