import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Spot, Interval } from '@binance/connector-typescript';
import { RSI } from 'technicalindicators';
import { Client } from 'pg'; // Importamos el cliente de Postgres
import axios from 'axios';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private binance: Spot;
  private db: Client;

  constructor() {
    this.binance = new Spot(
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_SECRET_KEY,
    );

    // Configuración de tu DB actual
    this.db = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: 5432,
      user: process.env.DB_USER || 'user_admin',
      password: process.env.DB_PASSWORD,
      database: 'db_gastos',
    });
  }

  async onModuleInit() {
    try {
      await this.db.connect();
      this.logger.log('✅ Conexión a DB Exitosa');
      // Solo arranca el análisis si la DB está lista
      await this.analizarMercado();
    } catch (err) {
      this.logger.error(
        '❌ No se pudo conectar a la DB. ¿Está el túnel activo o el contenedor corriendo?',
        err.message,
      );
    }
  }

  async analizarMercado() {
    try {
      // 1. Obtener datos de Binance
      const candles = await this.binance.klineCandlestickData(
        'BTCUSDT',
        Interval['1h'],
        { limit: 100 },
      );
      const closingPrices = candles.map((c) => parseFloat(c[4] as string));
      const precioActual = closingPrices[closingPrices.length - 1];

      // 2. Calcular RSI
      const rsiValues = RSI.calculate({ values: closingPrices, period: 14 });
      const rsiActual = rsiValues[rsiValues.length - 1];

      // 3. CONSULTAR MEMORIA: ¿Tengo algo abierto?
      const res = await this.db.query(
        "SELECT * FROM trading_operaciones WHERE ticker = 'BTCUSDT' AND estado = 'ABIERTA'",
      );
      const operacionAbierta = res.rows[0];

      this.logger.log(
        `BTC: $${precioActual} | RSI: ${rsiActual.toFixed(2)} | Abierta: ${!!operacionAbierta}`,
      );

      // 4. LÓGICA DE DECISIÓN (Perfil Moderado)

      // CASO A: No tengo nada y está "barato" -> COMPRAR (Simulado)
      if (!operacionAbierta && rsiActual < 35) {
        await this.registrarCompra('BTCUSDT', precioActual, 50); // Compramos 50 USD de prueba
        await this.notificar(
          `🛒 COMPRA SIMULADA: BTC a $${precioActual}\nRSI: ${rsiActual.toFixed(2)}\nGuardado en DB.`,
        );
      }

      // CASO B: Tengo algo abierto y está "caro" o gané 3% -> VENDER (Simulado)
      if (operacionAbierta) {
        const ganancia =
          ((precioActual - operacionAbierta.precio_compra) /
            operacionAbierta.precio_compra) *
          100;

        if (rsiActual > 65 || ganancia >= 3) {
          await this.registrarVenta(
            operacionAbierta.id,
            precioActual,
            ganancia,
          );
          await this.notificar(
            `💰 VENTA SIMULADA: BTC a $${precioActual}\nGanancia: ${ganancia.toFixed(2)}%\nPosición cerrada.`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error en el ciclo:', error.message);
    }
  }

  async registrarCompra(ticker: string, precio: number, monto: number) {
    const query = `INSERT INTO trading_operaciones (ticker, precio_compra, monto_usdt, estado) VALUES ($1, $2, $3, 'ABIERTA')`;
    await this.db.query(query, [ticker, precio, monto]);
  }

  async registrarVenta(id: number, precio: number, ganancia: number) {
    const query = `UPDATE trading_operaciones SET precio_venta = $1, ganancia_neta = $2, estado = 'CERRADA' WHERE id = $3`;
    await this.db.query(query, [precio, ganancia, id]);
  }

  async notificar(mensaje: string) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `🤖 TRADING BOT:\n${mensaje}`,
    });
  }
}
