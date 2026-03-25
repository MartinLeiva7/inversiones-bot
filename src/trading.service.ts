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
        const abierta = await this.db.query(
          "SELECT * FROM trading_operaciones WHERE estado = 'ABIERTA' LIMIT 1",
        );
        const pos = abierta.rows[0];

        let mensaje = `📊 *ESTADO DEL BOT*\n\n`;
        mensaje += `💰 *Saldo Spot:* ${saldoUSDT.toFixed(2)} USDT\n`;
        mensaje += `📈 *Trades Cerrados:* ${stats.total || 0}\n`;
        mensaje += `💵 *Ganancia Total:* ${parseFloat(stats.ganancia || 0).toFixed(2)} USDT\n\n`;

        if (pos) {
          mensaje += `⏳ *Posición Abierta:* BTC comprada a $${pos.precio_compra}\n`;
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
    const MONTO_OPERACION = 15; // De tus 88 USDT, usamos 15 por vez
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

      // Verificar en DB si hay posición abierta
      const res = await this.db.query(
        "SELECT * FROM trading_operaciones WHERE ticker = 'BTCUSDT' AND estado = 'ABIERTA'",
      );
      const operacionAbierta = res.rows[0];

      this.logger.log(
        `BTC: $${precioActual} | RSI: ${rsiActual.toFixed(2)} | Posición: ${operacionAbierta ? 'SÍ' : 'NO'}`,
      );

      // LÓGICA DE COMPRA
      if (!operacionAbierta && rsiActual < 35) {
        const saldo = await this.obtenerSaldoUSDT();
        if (saldo >= MONTO_OPERACION) {
          await this.ejecutarCompraReal('BTCUSDT', MONTO_OPERACION);
        } else {
          this.logger.warn(`Saldo insuficiente (${saldo} USDT) para comprar.`);
        }
      }

      // LÓGICA DE VENTA
      if (operacionAbierta) {
        const precioCompra = parseFloat(operacionAbierta.precio_compra);
        const ganancia = ((precioActual - precioCompra) / precioCompra) * 100;

        if (rsiActual > 65 || ganancia >= 2.0) {
          await this.ejecutarVentaReal(
            operacionAbierta.id,
            'BTCUSDT',
            precioActual,
            ganancia,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error en analizarMercado:', error.message);
    }
  }

  async ejecutarCompraReal(ticker: string, montoUSDT: number) {
    try {
      // Cambiamos 'BUY' por Side.BUY y 'MARKET' por OrderType.MARKET
      const order = await this.binance.newOrder(
        ticker,
        Side.BUY,
        OrderType.MARKET,
        {
          quoteOrderQty: montoUSDT,
        },
      );

      // Validamos que existan los fills para que TS no tire error
      if (!order.fills || order.fills.length === 0) {
        throw new Error(
          'La orden se ejecutó pero no hay detalles de precio (fills)',
        );
      }

      const precioEjecucion = parseFloat(order.fills[0].price);

      await this.db.query(
        `INSERT INTO trading_operaciones (ticker, precio_compra, monto_usdt, estado) VALUES ($1, $2, $3, 'ABIERTA')`,
        [ticker, precioEjecucion, montoUSDT],
      );

      await this.notificar(
        `🛒 COMPRA: BTC a $${precioEjecucion}\nRSI: ${montoUSDT} USDT invertidos.`,
      );
    } catch (error) {
      this.logger.error('Fallo Compra:', error.message);
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
      const cantidadAVender = parseFloat(btcBalance?.free || '0');

      // Cambiamos 'SELL' por Side.SELL y 'MARKET' por OrderType.MARKET
      const order = await this.binance.newOrder(
        ticker,
        Side.SELL,
        OrderType.MARKET,
        {
          quantity: cantidadAVender,
        },
      );

      if (!order.fills || order.fills.length === 0) {
        throw new Error('Venta ejecutada sin detalles de precio');
      }

      const precioVenta = parseFloat(order.fills[0].price);

      // 3. Actualizar DB
      await this.db.query(
        `UPDATE trading_operaciones SET precio_venta = $1, ganancia_neta = $2, estado = 'CERRADA' WHERE id = $3`,
        [precioVenta, ganancia, id],
      );

      await this.notificar(
        `💰 VENTA: BTC a $${precioVenta}\nGanancia: ${ganancia.toFixed(2)}%`,
      );
    } catch (error) {
      this.logger.error('Fallo Venta:', error.message);
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
}
