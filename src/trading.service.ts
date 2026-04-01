import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Spot, Interval, Side, OrderType } from '@binance/connector-typescript';
import { RSI } from 'technicalindicators';
import { Client } from 'pg';
import { Cron, CronExpression } from '@nestjs/schedule'; // Agregamos Cron
import axios from 'axios';
import { Telegraf } from 'telegraf';

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
      this.bot.launch();
      this.logger.log('✅ Bot de Telegram lanzado (Polling activo)');

      this.logger.log('⏳ Intentando conectar a la base de datos...');
      await this.db.connect();
      this.logger.log('✅ DB Conectada con éxito');

      // Ver saldo inicial
      await this.obtenerSaldoReal();
    } catch (err) {
      this.logger.error(`❌ Error crítico en inicio: ${err.message}`);
      // No cortamos el flujo aquí para que el bot de TG siga vivo si pudo arrancar
    }
  }

  private configurarComandos() {
    this.bot.command('status', async (ctx) => {
      try {
        // 1. Consultar saldo real en Binance
        const saldoUSDT = await this.obtenerSaldoUSDT();

        // 2. Consultar operaciones en la DB
        const res = await this.db.query(
          "SELECT COUNT(*) as total, SUM(ganancia_neta) as ganancia FROM trading_operaciones WHERE estado = 'CERRADA'",
        );
        const stats = res.rows[0];

        // 3. Ver si hay algo abierto ahora
        const abiertas = await this.db.query(
          "SELECT * FROM trading_operaciones WHERE estado = 'ABIERTA' ORDER BY fecha_compra DESC",
        );

        let mensaje = `📊 *ESTADO DEL BOT*\n\n`;
        mensaje += `💰 *Saldo Spot:* ${saldoUSDT.toFixed(2)} USDT\n`;
        mensaje += `📈 *Trades Cerrados:* ${stats.total || 0}\n`;
        mensaje += `💵 *Ganancia Total:* ${parseFloat(stats.ganancia || 0).toFixed(2)} USDT\n\n`;

        if (abiertas.rows.length > 0) {
          mensaje += `⏳ *Posiciones Abiertas (${abiertas.rows.length}):*\n`;
          abiertas.rows.forEach((pos, index) => {
            mensaje += `${index + 1}. BTC a $${parseFloat(pos.precio_compra).toLocaleString()}\n`;
          });
        } else {
          mensaje += `😴 *Estado:* Esperando oportunidad (RSI)...`;
        }

        await ctx.replyWithMarkdown(mensaje);
      } catch (error) {
        this.logger.error('Error en comando status:', error.message);
        await ctx.reply('❌ Error al obtener el estado.');
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
  }

  // MÉTODO NUEVO: Para saber cuánto efectivo tenés realmente
  async obtenerSaldoUSDT(): Promise<number> {
    try {
      const account = await this.binance.accountInformation();
      const usdt = account.balances.find((b) => b.asset === 'USDT');
      return parseFloat(usdt?.free || '0');
    } catch (error) {
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
    const MONTO_OPERACION = 15;
    const MAX_POSICIONES = 3; // Límite para no quedarnos sin USDT

    try {
      const candles = await this.binance.klineCandlestickData(
        'BTCUSDT',
        Interval['1h'],
        { limit: 100 },
      );
      const closingPrices = candles.map((c) => parseFloat(c[4] as string));
      const precioActual = closingPrices[closingPrices.length - 1];
      const rsiValues = RSI.calculate({ values: closingPrices, period: 14 });
      const rsiActual = rsiValues[rsiValues.length - 1];

      // Traer TODAS las posiciones abiertas
      const res = await this.db.query(
        "SELECT * FROM trading_operaciones WHERE ticker = 'BTCUSDT' AND estado = 'ABIERTA'",
      );
      const operacionesAbiertas = res.rows;

      this.logger.log(
        `BTC: $${precioActual} | RSI: ${rsiActual.toFixed(2)} | Posiciones abiertas: ${operacionesAbiertas.length}`,
      );

      // LÓGICA DE COMPRA (Solo si tenemos menos del máximo permitido)
      if (operacionesAbiertas.length < MAX_POSICIONES && rsiActual < 35) {
        const saldo = await this.obtenerSaldoUSDT();
        if (saldo >= MONTO_OPERACION) {
          await this.ejecutarCompraReal(
            'BTCUSDT',
            MONTO_OPERACION,
            precioActual,
          );
        }
      }

      // LÓGICA DE VENTA (Iteramos por cada posición abierta)
      for (const op of operacionesAbiertas) {
        const precioCompra = parseFloat(op.precio_compra);
        const ganancia = ((precioActual - precioCompra) / precioCompra) * 100;

        if (rsiActual > 65 || ganancia >= 2.0) {
          await this.ejecutarVentaReal(
            op.id,
            'BTCUSDT',
            precioActual,
            ganancia,
          );
          // Esperamos 2 segundos antes de procesar la siguiente posición
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      this.logger.error('Error en analizarMercado:', error.message);
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
      this.logger.error('Fallo Compra Real:', error.message);
      await this.notificar(`❌ ERROR EN COMPRA: ${error.message}`);
    }
  }

  async ejecutarVentaReal(
    id: number,
    ticker: string,
    precioActual: number,
    ganancia: number,
  ) {
    try {
      const account = await this.binance.accountInformation();
      const btcBalance = account.balances.find((b) => b.asset === 'BTC');
      const cantidadTotal = parseFloat(btcBalance?.free || '0');
      const valorEnUSDT = cantidadTotal * precioActual;

      // 1. Si no hay prácticamente nada de BTC, cerramos la posición en DB y salimos
      if (valorEnUSDT < 2) {
        this.logger.warn(
          `Saldo de BTC insignificante (${valorEnUSDT.toFixed(2)} USDT). Limpiando registro ID ${id}.`,
        );
        await this.db.query(
          `UPDATE trading_operaciones SET estado = 'CERRADA' WHERE id = $1`,
          [id],
        );
        return;
      }

      // 2. Ejecutamos la venta
      const order = await this.binance.newOrder(
        ticker,
        Side.SELL,
        OrderType.MARKET,
        {
          quantity: cantidadTotal,
        },
      );

      const precioVenta =
        order.fills && order.fills.length > 0
          ? parseFloat(order.fills[0].price)
          : precioActual;

      await this.db.query(
        `UPDATE trading_operaciones SET precio_venta = $1, ganancia_neta = $2, estado = 'CERRADA' WHERE estado = 'ABIERTA'`,
        [precioVenta, ganancia],
      );

      await this.notificar(
        `💰 VENTA TOTAL EXITOSA: BTC a $${precioVenta}\nSaldo recuperado en USDT.`,
      );
    } catch (error) {
      const errorMsg = error?.message || 'Error desconocido'; // <--- PROTECCIÓN AQUÍ
      this.logger.error(`Fallo Venta: ${errorMsg}`);

      // Si no hay saldo, limpiamos la DB para que no reintente eternamente
      if (
        errorMsg.includes('account has insufficient balance') ||
        errorMsg.includes('insufficient balance')
      ) {
        await this.db.query(
          "UPDATE trading_operaciones SET estado = 'CERRADA' WHERE estado = 'ABIERTA'",
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
      const misSaldos = account.balances.filter(
        (b) => parseFloat(b.free as string) > 0,
      );
      this.logger.log('--- 💰 SALDOS ACTUALES ---');
      misSaldos.forEach((s) => this.logger.log(`${s.asset}: ${s.free}`));
    } catch (e) {
      this.logger.error(e.message);
    }
  }

  // --- MÉTODOS AUXILIARES PARA EL RESUMEN ---

  async obtenerPrecioActualBTC(): Promise<number> {
    const ticker = await this.binance.symbolPriceTicker({ symbol: 'BTCUSDT' });
    // @ts-expect-error (Binance connector a veces devuelve array o objeto dependiendo de la versión)
    return parseFloat(ticker.price || ticker[0].price);
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
      this.logger.error(`❌ Error en resumen diario: ${error.message}`);
    }
  }
}
