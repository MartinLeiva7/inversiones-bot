# 🤖 Inversiones Bot - Trading Automático en Binance

Un bot de trading automático construido con **NestJS** y **TypeScript**. Este bot opera en Binance con el par `BTC/USDT` utilizando una estrategia combinada de los indicadores **RSI (Relative Strength Index)** y **MACD (Moving Average Convergence Divergence)** con gestión de cuadrícula (Grid Step) y reporta toda su actividad a través de **Telegram**. Además, persiste el registro de las operaciones en una base de datos **PostgreSQL**.

## 🚀 Funcionalidades Principales

### 📈 Estrategia de Trading (RSI + MACD + Grid Step)
- Analiza periódicamente el mercado (por defecto cada 1 hora) utilizando velas de temporalidad de 1H para el par **BTC/USDT**.
- **Señal de Compra Automática**: Se ejecuta una orden de compra `MARKET` por un monto fijo de **25 USDT** si se cumplen todas estas condiciones:
  - Hay menos del límite de posiciones abiertas (`MAX_POSICIONES = 3`).
  - El valor del **RSI es menor a 35** (sobreventa).
  - El **histograma de MACD está subiendo** (`histogramActual > histogramPrev`), confirmando una desaceleración de la caída o rebote (momentum alcista).
  - **Filtro de Grid Step**: Si ya hay posiciones abiertas, el precio actual de BTC debe ser al menos un **5.0% menor** que el precio de compra más bajo de las posiciones abiertas. Esto evita acumular posiciones al mismo precio durante una caída.
- **Señal de Venta Individual (Take Profit)**: Cada posición abierta (tanto automática como manual) se gestiona y vende de manera independiente. Se ejecuta una orden de venta de la cantidad de BTC correspondiente a esa posición específica si se cumple alguna de estas dos condiciones:
  - El **RSI supera 65** (sobrecompra) y la posición está en ganancia (`ganancia > 0`).
  - La **ganancia neta de esa posición es igual o mayor al 2.0%** (Take profit por porcentaje).
  - *Nota*: Las demás posiciones que no cumplan estas condiciones se mantendrán abiertas, evitando realizar ventas a pérdida.

### 📱 Integración con Telegram (Comandos)
El bot se comunica en tiempo real con un chat de un usuario/grupo de Telegram. Te permite interactuar y consultar el estado de tu cuenta mediante los siguientes comandos:
- `/status`: Muestra un panel de resumen con tu saldo actual en Spot (USDT), la cantidad de operaciones cerradas históricamente, la ganancia total acumulada y el listado detallado de posiciones abiertas con su respectivo porcentaje de ganancia/pérdida flotante.
- `/rsi`: Consulta bajo demanda las velas de Binance y te devuelve el valor exacto del RSI de BTC en la temporalidad de 1H en ese instante.
- `/comprar <monto_usdt>` o `/buy <monto_usdt>`:
  - **Sin parámetros**: Muestra el saldo disponible de USDT en Spot e instrucciones de uso.
  - **Con parámetros (Ej: `/comprar 25`)**: Ejecuta una compra manual de BTC por el monto indicado en Binance. La posición queda registrada como `ABIERTA` en la base de datos para que el ciclo automático la gestione y venda con ganancias.

### 📊 Reportes y Notificaciones Automáticas
- **Notificaciones de Operación**: Genera alertas inmediatas a Telegram cada vez que se ejecuta una compra o una venta con éxito, informando el precio de ejecución, la ganancia obtenida en caso de venta y el saldo.
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
- **[TechnicalIndicators](https://github.com/anandanand84/technicalindicators)**: Paquete para el cálculo matemático de los indicadores RSI y MACD.
- **[PostgreSQL (pg)](https://node-postgres.com/)**: Motor de base de datos relacional para guardar operaciones de forma segura.
- **Docker & Docker Compose**: Contenerización lista para entornos de producción.

## ⚙️ Configuración (Variables de Enorno)

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
