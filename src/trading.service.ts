import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Spot, Interval, Side, OrderType } from '@binance/connector-typescript';
import { RSI, MACD } from 'technicalindicators';
import { Client } from 'pg';
import { Cron, CronExpression } from '@nestjs/schedule'; // Agregamos Cron
import axios from 'axios';
import { Telegraf } from 'telegraf';

interface TradingOperacion {
  id: number;
  ticker: string;
  precio_compra: string;
  precio_venta: string | null;
  monto_usdt: string;
  estado: string;
  fecha_compra: Date;
  ganancia_neta: string | null;
}

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private binance: Spot;
  private db: Client;
  private bot: Telegraf;

  constructor() {
    this.db = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: 5432,
      user: process.env.DB_USER || 'user_admin',
      password: process.env.DB_PASSWORD,
      database: 'db_gastos',
    });
    this.bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
  }

  private initBinance() {
    const apiKey = process.env.BINANCE_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_SECRET_KEY?.trim();

    if (!apiKey || !apiSecret) {
      throw new Error('Faltan las API Keys en el .env');
    }

    this.binance = new Spot(apiKey, apiSecret, {
      baseURL: 'https://api.binance.com',
    });
  }

  async onModuleInit() {
    this.logger.log('🔍 DIAGNÓSTICO DE INICIO:');
    this.logger.log(`> DB_HOST: ${process.env.DB_HOST}`);
    this.logger.log(`> DB_USER: ${process.env.DB_USER}`);
    this.logger.log(`> DB_NAME: ${process.env.DB_NAME}`);
    this.logger.log(
      `> TG_TOKEN: ${process.env.TELEGRAM_TOKEN ? '✅ Cargado' : '❌ VACÍO'}`,
    );

    try {
      this.initBinance();

      // IMPORTANTE: Arrancamos el bot de Telegram ANTES que la DB
      // Así, si la DB falla, el bot al menos puede responderte un error.
      this.configurarComandos();
      void this.bot.launch();
      this.logger.log('✅ Bot de Telegram lanzado (Polling activo)');

      this.logger.log('⏳ Intentando conectar a la base de datos...');
      await this.db.connect();
      this.logger.log('✅ DB Conectada con éxito');

      // Ver saldo inicial
      await this.obtenerSaldoReal();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`❌ Error crítico en inicio: ${errMsg}`);
      // No cortamos el flujo aquí para que el bot de TG siga vivo si pudo arrancar
    }
  }

  private configurarComandos() {
    this.bot.command('status', async (ctx) => {
      try {
        // 1. Obtener datos de mercado en tiempo real
        const precioBTC = await this.obtenerPrecioActualBTC();
        const rsiActual = await this.calcularRSICuandoSea();
        const saldoUSDT = await this.obtenerSaldoUSDT();

        // 2. Consultar estadísticas de la DB
        const res = await this.db.query<{
          total: string;
          ganancia: string | null;
        }>(
          "SELECT COUNT(*) as total, SUM(ganancia_neta) as ganancia FROM trading_operaciones WHERE estado = 'CERRADA'",
        );
        const stats = res.rows[0] || { total: '0', ganancia: '0' };

        // 3. Ver posiciones abiertas
        const abiertas = await this.db.query<TradingOperacion>(
          "SELECT * FROM trading_operaciones WHERE estado = 'ABIERTA' ORDER BY fecha_compra DESC",
        );

        // 4. Armar el mensaje súper completo
        let mensaje = `📊 *ESTADO DEL BOT EN VIVO*\n`;
        mensaje += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n`;
        mensaje += `₿ *BTC:* $${precioBTC.toLocaleString()}  |  📊 *RSI:* ${rsiActual.toFixed(2)}\n`;
        mensaje += `💰 *Saldo Spot:* ${saldoUSDT.toFixed(2)} USDT\n`;
        mensaje += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n`;
        mensaje += `📈 *Trades Cerrados:* ${stats.total || 0}\n`;
        mensaje += `💵 *Ganancia Total:* ${parseFloat(stats.ganancia || '0').toFixed(2)} USDT\n\n`;

        if (abiertas.rows.length > 0) {
          mensaje += `⏳ *Posiciones Abiertas (${abiertas.rows.length}):*\n`;
          abiertas.rows.forEach((pos, index) => {
            const pCompra = parseFloat(pos.precio_compra);
            const diff = ((precioBTC - pCompra) / pCompra) * 100;
            const emoji = diff >= 0 ? '✅' : '🔻';

            mensaje += `${index + 1}. $${pCompra.toLocaleString()} (${emoji} ${diff.toFixed(2)}%)\n`;
          });
        } else {
          mensaje += `😴 *Estado:* Esperando RSI < 35 para comprar.`;
        }

        await ctx.replyWithMarkdown(mensaje);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error('Error en comando status:', errMsg);
        await ctx.reply('❌ Error al obtener el estado completo.');
      }
    });

    // Comando extra para ver el RSI actual rápido
    this.bot.command('rsi', async (ctx) => {
      const candles = await this.binance.klineCandlestickData(
        'BTCUSDT',
        Interval['1h'],
        { limit: 100 },
      );
      const prices = candles.map((c) => parseFloat(c[4] as string));
      const rsiValues = RSI.calculate({ values: prices, period: 14 });
      const rsiActual = rsiValues[rsiValues.length - 1];
      await ctx.reply(`📊 RSI Actual de BTC (1h): ${rsiActual.toFixed(2)}`);
    });

    // Nuevo comando para comprar BTC a partir de un monto manual en USDT
    this.bot.command(['comprar', 'buy'], async (ctx) => {
      try {
        const mensaje = ctx.message.text.trim();
        const partes = mensaje.split(/\s+/);

        if (partes.length < 2) {
          const saldoUSDT = await this.obtenerSaldoUSDT();
          await ctx.replyWithMarkdown(
            `💰 *Saldo Spot disponible:* ${saldoUSDT.toFixed(2)} USDT\n\n` +
              `Para realizar una compra manual de BTC, usa el formato:\n` +
              `\`/comprar <monto_usdt>\`\n` +
              `Ejemplo: \`/comprar 25\``,
          );
          return;
        }

        const montoStr = partes[1].replace(',', '.');
        const montoUSDT = parseFloat(montoStr);

        if (isNaN(montoUSDT) || montoUSDT <= 0) {
          await ctx.reply(
            '❌ El monto ingresado no es válido. Debe ser un número mayor a 0.',
          );
          return;
        }

        const saldoUSDT = await this.obtenerSaldoUSDT();
        if (montoUSDT > saldoUSDT) {
          await ctx.reply(
            `❌ Saldo insuficiente. Tenés *${saldoUSDT.toFixed(2)} USDT* disponibles y querés comprar *${montoUSDT.toFixed(2)} USDT*.`,
            { parse_mode: 'Markdown' },
          );
          return;
        }

        await ctx.reply(
          `⏳ Iniciando compra manual de BTC por *${montoUSDT.toFixed(2)} USDT*...`,
          {
            parse_mode: 'Markdown',
          },
        );

        const precioActual = await this.obtenerPrecioActualBTC();
        await this.ejecutarCompraReal('BTCUSDT', montoUSDT, precioActual);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error('Error en comando comprar/buy:', errMsg);
        await ctx.reply(`❌ Error al ejecutar el comando de compra: ${errMsg}`);
      }
    });
  }

  // MÉTODO NUEVO: Para saber cuánto efectivo tenés realmente
  async obtenerSaldoUSDT(): Promise<number> {
    try {
      const account = await this.binance.accountInformation();
      const usdt = account.balances.find((b) => b.asset === 'USDT');
      return parseFloat(usdt?.free || '0');
    } catch {
      this.logger.error('Error obteniendo saldo USDT');
      return 0;
    }
  }

  // TAREA PROGRAMADA: Se ejecuta cada 1 hora
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    this.logger.log('--- Iniciando ciclo automático ---');
    await this.analizarMercado();
  }

  async analizarMercado() {
    const MONTO_OPERACION = 25;
    const MAX_POSICIONES = 3; // Límite para no quedarnos sin USDT

    try {
      const candles = await this.binance.klineCandlestickData(
        'BTCUSDT',
        Interval['1h'],
        { limit: 100 },
      );
      const closingPrices = candles.map((c) => parseFloat(c[4] as string));
      const precioActual = closingPrices[closingPrices.length - 1];

      // Cálculo de RSI
      const rsiValues = RSI.calculate({ values: closingPrices, period: 14 });
      const rsiActual = rsiValues[rsiValues.length - 1];

      // Cálculo de MACD
      const macdValues = MACD.calculate({
        values: closingPrices,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      const macdActual = macdValues[macdValues.length - 1];
      const macdPrev = macdValues[macdValues.length - 2];

      const histogramActual = macdActual?.histogram ?? 0;
      const histogramPrev = macdPrev?.histogram ?? 0;

      // Momentum alcista: el histograma está subiendo
      const momentumBullish = histogramActual > histogramPrev;

      // Traer TODAS las posiciones abiertas
      const res = await this.db.query<TradingOperacion>(
        "SELECT * FROM trading_operaciones WHERE ticker = 'BTCUSDT' AND estado = 'ABIERTA'",
      );
      const operacionesAbiertas = res.rows;

      this.logger.log(
        `BTC: $${precioActual} | RSI: ${rsiActual.toFixed(2)} | MACD Hist: ${histogramActual.toFixed(4)} (Prev: ${histogramPrev.toFixed(4)}) | Posiciones abiertas: ${operacionesAbiertas.length}`,
      );

      // LÓGICA DE COMPRA (Solo si tenemos menos del máximo permitido)
      let puedeComprar = operacionesAbiertas.length < MAX_POSICIONES;

      // Validar Grid Step (mínimo 5% de caída respecto al precio mínimo de las posiciones abiertas)
      if (puedeComprar && operacionesAbiertas.length > 0) {
        const precioMinCompra = Math.min(
          ...operacionesAbiertas.map((op) => parseFloat(op.precio_compra)),
        );
        const dropPercentage =
          ((precioMinCompra - precioActual) / precioMinCompra) * 100;

        if (dropPercentage < 5.0) {
          puedeComprar = false;
          this.logger.log(
            `Compra cancelada por Grid Step. Precio actual: $${precioActual}, Precio mínimo de compra: $${precioMinCompra} (Caída: ${dropPercentage.toFixed(2)}% < 5%)`,
          );
        }
      }

      if (puedeComprar && rsiActual < 35 && momentumBullish) {
        const saldo = await this.obtenerSaldoUSDT();
        if (saldo >= MONTO_OPERACION) {
          await this.ejecutarCompraReal(
            'BTCUSDT',
            MONTO_OPERACION,
            precioActual,
          );
        }
      }

      // LÓGICA DE VENTA (Iteramos por cada posición abierta y gestionamos de forma individual)
      for (const op of operacionesAbiertas) {
        const precioCompra = parseFloat(op.precio_compra);
        const ganancia = ((precioActual - precioCompra) / precioCompra) * 100;

        if (ganancia >= 2.0 || (rsiActual > 65 && ganancia > 0)) {
          await this.ejecutarVentaReal(
            op.id,
            'BTCUSDT',
            precioActual,
            ganancia,
            parseFloat(op.monto_usdt),
            precioCompra,
          );
          // Esperamos 2 segundos antes de procesar la siguiente posición
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Error en analizarMercado:', errMsg);
    }
  }

  async ejecutarCompraReal(
    ticker: string,
    montoUSDT: number,
    precioActual: number,
  ) {
    try {
      const order = await this.binance.newOrder(
        ticker,
        Side.BUY,
        OrderType.MARKET,
        {
          quoteOrderQty: montoUSDT,
        },
      );

      // Si no hay fills, usamos el precioActual que pasamos por parámetro
      const precioEjecucion =
        order.fills && order.fills.length > 0
          ? parseFloat(order.fills[0].price)
          : precioActual;

      await this.db.query(
        `INSERT INTO trading_operaciones (ticker, precio_compra, monto_usdt, estado, fecha_compra) VALUES ($1, $2, $3, 'ABIERTA', NOW())`,
        [ticker, precioEjecucion, montoUSDT],
      );

      await this.notificar(
        `🛒 COMPRA REAL: BTC a $${precioEjecucion}\nInvertidos: ${montoUSDT} USDT`,
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Fallo Compra Real:', errMsg);
      await this.notificar(`❌ ERROR EN COMPRA: ${errMsg}`);
    }
  }

  async ejecutarVentaReal(
    id: number,
    ticker: string,
    precioActual: number,
    ganancia: number,
    montoUSDT: number,
    precioCompra: number,
  ) {
    try {
      const cantidadCalculada = montoUSDT / precioCompra;
      const account = await this.binance.accountInformation();
      const btcBalance = account.balances.find((b) => b.asset === 'BTC');
      const cantidadDisponible = parseFloat(btcBalance?.free || '0');

      // Vender el menor valor entre el calculado y el disponible realmente
      const cantidadAVender = Math.min(cantidadCalculada, cantidadDisponible);
      const cantidadTruncada = Math.floor(cantidadAVender * 10000) / 10000;
      const valorEnUSDT = cantidadTruncada * precioActual;

      // 1. Si no hay prácticamente nada de BTC o el valor es insignificante, cerramos en la DB y salimos
      if (valorEnUSDT < 2) {
        this.logger.warn(
          `Saldo de BTC insignificante (${valorEnUSDT.toFixed(2)} USDT) para la posición ID ${id}. Limpiando registro.`,
        );
        await this.db.query(
          `UPDATE trading_operaciones SET estado = 'CERRADA', precio_venta = $1, ganancia_neta = $2 WHERE id = $3`,
          [precioActual, ganancia, id],
        );
        return;
      }

      this.logger.log(
        `Intentando vender ${cantidadTruncada} BTC para la posición ID ${id}...`,
      );

      const order = await this.binance.newOrder(
        ticker,
        Side.SELL,
        OrderType.MARKET,
        {
          quantity: cantidadTruncada,
          recvWindow: 10000, // Margen de sincronización de tiempo
        },
      );

      const precioVenta =
        order.fills && order.fills.length > 0
          ? parseFloat(order.fills[0].price)
          : precioActual;

      const gananciaReal = ((precioVenta - precioCompra) / precioCompra) * 100;

      // Actualizamos únicamente la posición correspondiente a este ID
      await this.db.query(
        `UPDATE trading_operaciones 
         SET precio_venta = $1, ganancia_neta = $2, estado = 'CERRADA' 
         WHERE id = $3`,
        [precioVenta, gananciaReal, id],
      );

      await this.notificar(
        `💰 VENTA EXITOSA: BTC a $${precioVenta}\n` +
          `Posición ID: ${id}\n` +
          `Monto vendido: ~${(cantidadTruncada * precioVenta).toFixed(2)} USDT (${cantidadTruncada} BTC)\n` +
          `Ganancia neta: ${gananciaReal.toFixed(2)}%`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Fallo Venta para posición ID ${id}: ${errorMsg}`);

      // Si no hay saldo, limpiamos este registro específico para que no intente eternamente
      if (
        errorMsg.includes('account has insufficient balance') ||
        errorMsg.includes('insufficient balance')
      ) {
        await this.db.query(
          "UPDATE trading_operaciones SET estado = 'CERRADA' WHERE id = $1",
          [id],
        );
      }
    }
  }

  async notificar(mensaje: string) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `🤖 TRADING BOT:\n${mensaje}`,
    });
  }

  // Método opcional para ver todos los saldos (el que usaste para probar)
  async obtenerSaldoReal() {
    try {
      const account = await this.binance.accountInformation();
      const misSaldos = account.balances.filter((b) => parseFloat(b.free) > 0);
      this.logger.log('--- 💰 SALDOS ACTUALES ---');
      misSaldos.forEach((s) => this.logger.log(`${s.asset}: ${s.free}`));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(errMsg);
    }
  }

  // --- MÉTODOS AUXILIARES PARA EL RESUMEN ---

  async obtenerPrecioActualBTC(): Promise<number> {
    const ticker = await this.binance.symbolPriceTicker({ symbol: 'BTCUSDT' });
    if (Array.isArray(ticker)) {
      return parseFloat(ticker[0].price);
    }
    return parseFloat(ticker.price);
  }

  async calcularRSICuandoSea(): Promise<number> {
    const candles = await this.binance.klineCandlestickData(
      'BTCUSDT',
      Interval['1h'],
      { limit: 100 },
    );
    const prices = candles.map((c) => parseFloat(c[4] as string));
    const rsiValues = RSI.calculate({ values: prices, period: 14 });
    return rsiValues[rsiValues.length - 1];
  }

  // --- EL CRON DEL RESUMEN DIARIO ---

  @Cron('0 9 * * *', {
    name: 'resumen_diario',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async enviarResumenDiario() {
    this.logger.log('📊 Generando resumen diario automático...');

    try {
      const precio = await this.obtenerPrecioActualBTC();
      const rsi = await this.calcularRSICuandoSea();
      const saldo = await this.obtenerSaldoUSDT();

      const mensaje = `📅 *RESUMEN DIARIO* 📊
-------------------------
💰 *Saldo Spot:* ${saldo.toFixed(2)} USDT
₿ *Precio BTC:* $${precio.toLocaleString()}
📈 *RSI Actual:* ${rsi.toFixed(2)}

${rsi < 40 ? '⚠️ ¡RSI Bajo! Cerca de zona de compra.' : '✅ Mercado estable.'}
-------------------------
_Seguimos vigilando 24/7 desde Catamarca_ 🛡️`;

      await this.bot.telegram.sendMessage(
        process.env.TELEGRAM_CHAT_ID || '',
        mensaje,
        { parse_mode: 'Markdown' },
      );

      this.logger.log('✅ Resumen diario enviado a Telegram');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Error en resumen diario: ${errMsg}`);
    }
  }
}
