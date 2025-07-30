const WebSocket = require('ws');
const axios = require('axios');
const colors = require('colors');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// =============== CONFIGURATION ===============
const CONFIG = {
    // Market Data Config
    DEFAULT_PAIRS: ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'SOLUSDT'],
    TIMEFRAMES: {
        '15m': { period: 9 },
        '1h': { period: 21 }
    },
    BUFFER_SIZE: 100,

    // Risk Management
    RISK: {
        ACCOUNT_SIZE: 10000,
        RISK_PER_TRADE: 0.02,
        MAX_POSITION_SIZE: 1000,
        BASE_LEVERAGE: 10,
        MAX_LEVERAGE: 20,
        STOP_LOSS_MULTIPLIER: 1.5,
        TAKE_PROFIT_MULTIPLIER: 3,
    },

    // Trading Rules
    TRADING: {
        MIN_VOLATILITY: 5,
        MAX_VOLATILITY: 50,
        VOLUME_THRESHOLD: 1.2,
        MIN_CONFIDENCE: 'MEDIUM'
    },

    // Technical Settings
    TECHNICAL: {
        RSI_PERIOD: 14,
        VOLATILITY_PERIOD: 20,
        VOLUME_MA_PERIOD: 20
    },

    // System Settings
    SYSTEM: {
        RETRY_DELAY: 1000,
        UPDATE_INTERVAL: 1000,
        MAX_RETRIES: 3,
        API_RATE_LIMIT: 1200
    }
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Global trackers storage
const trackers = new Map();
const globalWebSocket = new Map();

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// =============== API ENDPOINTS ===============

// Get available pairs endpoint
app.get('/pairs', async (req, res) => {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
        const usdtPairs = response.data.symbols
            .filter(symbol =>
                symbol.symbol.endsWith('USDT') &&
                symbol.status === 'TRADING'
            )
            .map(symbol => symbol.symbol)
            .sort();

        res.json({
            success: true,
            pairs: usdtPairs,
            defaultPairs: CONFIG.DEFAULT_PAIRS
        });
    } catch (error) {
        console.error('Error fetching pairs:', error);
        res.json({
            success: true,
            pairs: CONFIG.DEFAULT_PAIRS,
            defaultPairs: CONFIG.DEFAULT_PAIRS,
            message: 'Using fallback pairs due to API error'
        });
    }
});

// Get active pairs
app.get('/active-pairs', (req, res) => {
    const activePairs = Array.from(trackers.keys());
    res.json({
        success: true,
        pairs: activePairs
    });
});

// Start tracking a pair
app.post('/start-pair/:pair', async (req, res) => {
    try {
        const pair = req.params.pair.toUpperCase();
        console.log(`API call to start tracking ${pair}`.yellow);

        if (trackers.has(pair)) {
            console.log(`Already tracking ${pair}`.yellow);
            return res.json({
                success: true,
                message: `Already tracking ${pair}`,
                pair
            });
        }

        console.log(`Starting new tracker for ${pair}...`.green);
        const tracker = new FuturesTracker(pair);
        trackers.set(pair, tracker);

        // Start the tracker
        await tracker.start();

        console.log(`Successfully started tracker for ${pair}`.green);

        res.json({
            success: true,
            message: `Started tracking ${pair}`,
            pair
        });

    } catch (error) {
        console.error(`Error starting tracker for ${req.params.pair}:`.red, error);

        // Remove failed tracker
        const pair = req.params.pair.toUpperCase();
        if (trackers.has(pair)) {
            trackers.delete(pair);
        }

        res.status(500).json({
            success: false,
            message: `Failed to start tracking ${req.params.pair}: ${error.message}`
        });
    }
});

// Stop tracking a pair
app.post('/stop-pair/:pair', async (req, res) => {
    try {
        const pair = req.params.pair.toUpperCase();

        if (!trackers.has(pair)) {
            return res.status(404).json({
                success: false,
                message: `Not tracking ${pair}`
            });
        }

        // Close WebSocket connection for this pair
        if (globalWebSocket.has(pair)) {
            globalWebSocket.get(pair).close();
            globalWebSocket.delete(pair);
        }

        // Remove tracker
        trackers.delete(pair);

        res.json({
            success: true,
            message: `Stopped tracking ${pair}`,
            pair
        });

    } catch (error) {
        console.error(`Error stopping tracker for ${req.params.pair}:`, error);
        res.status(500).json({
            success: false,
            message: `Failed to stop tracking ${req.params.pair}: ${error.message}`
        });
    }
});

// Manual trade endpoint
app.post('/trade/:pair', async (req, res) => {
    const { pair } = req.params;
    const { type, size, leverage } = req.body;

    const tracker = trackers.get(pair.toUpperCase());
    if (!tracker) {
        return res.status(404).json({
            success: false,
            message: `Tracker for ${pair} not found. Please start tracking this pair first.`
        });
    }

    if (!tracker.currentPrice) {
        return res.status(400).json({
            success: false,
            message: 'Price not available for this pair'
        });
    }

    // Create manual signal
    const manualSignal = {
        signal: type === 'long' ? 'MANUAL_BUY' : 'MANUAL_SELL',
        confidence: 'HIGH',
        reason: 'Manual trade execution'
    };

    // Create position parameters
    const position = tracker.positionManager.calculatePositionParameters(
        manualSignal,
        tracker.currentPrice,
        tracker.getMarketState().volatility
    );

    // Override position size and leverage if provided
    if (size) position.size = parseFloat(size);
    if (leverage) position.leverage = parseInt(leverage);

    // Add unique ID to position
    position.id = `${pair}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Execute the trade
    await tracker.tradeExecutor.executePosition(position);

    res.json({
        success: true,
        message: `Manual ${type} position opened for ${pair}`,
        position
    });
});

// Close position endpoint
app.post('/close/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const { reason = 'Manual close' } = req.body;

        const tracker = trackers.get(pair.toUpperCase());
        if (!tracker) {
            return res.status(404).json({
                success: false,
                message: `Tracker for ${pair} not found`
            });
        }

        if (!tracker.positionManager.activePosition) {
            return res.status(400).json({
                success: false,
                message: 'No active position to close'
            });
        }

        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        await tracker.tradeExecutor.closePosition(reason, tracker.currentPrice);

        res.json({
            success: true,
            message: 'Position closed successfully',
            pair,
            closingPrice: tracker.currentPrice
        });

    } catch (error) {
        console.error('Error closing position:', error);
        res.status(500).json({
            success: false,
            message: `Failed to close position: ${error.message}`
        });
    }
});

// Close specific position by ID
app.post('/close/:pair/:positionId', async (req, res) => {
    try {
        const { pair, positionId } = req.params;
        const { reason = 'Manual close' } = req.body;

        const tracker = trackers.get(pair.toUpperCase());
        if (!tracker) {
            return res.status(404).json({
                success: false,
                message: `Tracker for ${pair} not found`
            });
        }

        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        const result = await tracker.tradeExecutor.closeSpecificPosition(positionId, reason, tracker.currentPrice);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json({
            ...result,
            pair
        });

    } catch (error) {
        console.error('Error closing specific position:', error);
        res.status(500).json({
            success: false,
            message: `Failed to close position: ${error.message}`
        });
    }
});

// Close all positions endpoint
app.post('/close-all/:pair', async (req, res) => {
    try {
        const { pair } = req.params;
        const { reason = 'Close all positions' } = req.body;

        const tracker = trackers.get(pair.toUpperCase());
        if (!tracker) {
            return res.status(404).json({
                success: false,
                message: `Tracker for ${pair} not found`
            });
        }

        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        const result = await tracker.tradeExecutor.closeAllPositions(reason, tracker.currentPrice);

        res.json({
            ...result,
            pair
        });

    } catch (error) {
        console.error('Error closing all positions:', error);
        res.status(500).json({
            success: false,
            message: `Failed to close all positions: ${error.message}`
        });
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected to dashboard');

    socket.on('subscribe-pair', async (pair) => {
        try {
            const upperPair = pair.toUpperCase();
            console.log(`Client subscribing to ${upperPair}`.cyan);

            // Join room for this pair
            socket.join(upperPair);

            // Start tracking if not already tracking
            if (!trackers.has(upperPair)) {
                console.log(`Auto-starting tracker for ${upperPair}...`.yellow);
                try {
                    const tracker = new FuturesTracker(upperPair);
                    trackers.set(upperPair, tracker);
                    await tracker.start();
                    console.log(`Successfully started tracker for ${upperPair}`.green);
                } catch (startError) {
                    console.error(`Failed to start tracker for ${upperPair}:`.red, startError);
                    trackers.delete(upperPair);
                    socket.emit('subscription-error', {
                        pair: upperPair,
                        error: `Failed to start tracker: ${startError.message}`
                    });
                    return;
                }
            }

            // Send current data immediately if available
            const tracker = trackers.get(upperPair);
            if (tracker && tracker.currentPrice) {
                try {
                    const dashboardData = tracker.getDashboardData();
                    socket.emit('marketUpdate', dashboardData);
                    console.log(`Sent initial data for ${upperPair}`.green);
                } catch (dataError) {
                    console.error(`Error getting dashboard data for ${upperPair}:`.red, dataError);
                }
            }

            socket.emit('subscription-success', { pair: upperPair });
            console.log(`Successfully subscribed client to ${upperPair}`.green);

        } catch (error) {
            console.error(`Error subscribing to ${pair}:`.red, error);
            socket.emit('subscription-error', {
                pair,
                error: error.message
            });
        }
    });

    socket.on('unsubscribe-pair', (pair) => {
        const upperPair = pair.toUpperCase();
        console.log(`Client unsubscribing from ${upperPair}`);
        socket.leave(upperPair);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected from dashboard');
    });
});

// =============== UTILITIES ===============
class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.pointer = 0;
        this.size = 0;
    }

    push(item) {
        this.buffer[this.pointer] = item;
        this.pointer = (this.pointer + 1) % this.capacity;
        this.size = Math.min(this.size + 1, this.capacity);
    }

    getAll() {
        if (this.size < this.capacity) {
            return this.buffer.slice(0, this.size);
        }
        return [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)];
    }

    getLast(n) {
        return this.getAll().slice(-n);
    }
}

class RateLimiter {
    constructor(limitPerMinute) {
        this.limitPerMinute = limitPerMinute;
        this.requests = [];
    }

    async throttle() {
        const now = Date.now();
        this.requests = this.requests.filter(time => time > now - 60000);

        if (this.requests.length >= this.limitPerMinute) {
            const waitTime = 60000 - (now - this.requests[0]);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.requests.push(now);
    }
}

class TradingError extends Error {
    constructor(message, code, retryable = false) {
        super(message);
        this.name = 'TradingError';
        this.code = code;
        this.retryable = retryable;
    }
}

// =============== MARKET DATA MANAGEMENT ===============
class MarketData {
    constructor(timeframe) {
        this.prices = new CircularBuffer(CONFIG.BUFFER_SIZE);
        this.volumes = new CircularBuffer(CONFIG.BUFFER_SIZE);
        this.times = new CircularBuffer(CONFIG.BUFFER_SIZE);
        this.period = CONFIG.TIMEFRAMES[timeframe].period;
    }

    addCandle(price, volume, time) {
        this.prices.push(price);
        this.volumes.push(volume);
        this.times.push(time);
    }

    getData() {
        return {
            prices: this.prices.getAll(),
            volumes: this.volumes.getAll(),
            times: this.times.getAll()
        };
    }

    getLatest() {
        const prices = this.prices.getAll();
        return prices[prices.length - 1];
    }
}

// =============== TECHNICAL ANALYSIS ===============
class TechnicalAnalysis {
    static calculateVWMA(prices, volumes, period) {
        if (prices.length < period) return null;

        let sumVolumePrice = 0;
        let sumVolume = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            sumVolumePrice += prices[i] * volumes[i];
            sumVolume += volumes[i];
        }

        return sumVolume === 0 ? null : sumVolumePrice / sumVolume;
    }

    static calculateRSI(prices, period = CONFIG.TECHNICAL.RSI_PERIOD) {
        if (prices.length <= period) return null;

        let gains = 0, losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static calculateVolatility(prices, period = CONFIG.TECHNICAL.VOLATILITY_PERIOD) {
        if (prices.length < period + 1) return 0;

        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }

        const sumSquared = returns.reduce((sum, ret) => sum + ret * ret, 0);
        return Math.sqrt(sumSquared / period) * 100;
    }

    static analyzeVolume(volumes, period = CONFIG.TECHNICAL.VOLUME_MA_PERIOD) {
        if (volumes.length < period) return null;

        const avgVolume = volumes
            .slice(-period)
            .reduce((sum, vol) => sum + vol, 0) / period;

        const currentVolume = volumes[volumes.length - 1];
        const volumeRatio = currentVolume / avgVolume;

        return {
            average: avgVolume,
            current: currentVolume,
            ratio: volumeRatio,
            increasing: volumeRatio > CONFIG.TRADING.VOLUME_THRESHOLD
        };
    }

    static calculateFibonacciLevels(prices, lookbackPeriod = 20) {
        if (prices.length < lookbackPeriod) return null;

        const recentPrices = prices.slice(-lookbackPeriod);
        const high = Math.max(...recentPrices);
        const low = Math.min(...recentPrices);

        const ratios = {
            '0': 0,
            '0.236': 0.236,
            '0.382': 0.382,
            '0.5': 0.5,
            '0.618': 0.618,
            '0.786': 0.786,
            '1': 1
        };

        const isUptrend = recentPrices[recentPrices.length - 1] > recentPrices[0];
        const levels = {};

        if (isUptrend) {
            Object.entries(ratios).forEach(([key, ratio]) => {
                levels[key] = high - (high - low) * ratio;
            });
        } else {
            Object.entries(ratios).forEach(([key, ratio]) => {
                levels[key] = low + (high - low) * ratio;
            });
        }

        return {
            levels,
            trend: isUptrend ? 'UPTREND' : 'DOWNTREND',
            high,
            low
        };
    }

    static analyzeFibonacciSignals(currentPrice, fibLevels) {
        if (!fibLevels) return null;

        const { levels, trend } = fibLevels;
        let support = null;
        let resistance = null;
        let nearestLevel = null;
        let nearestDistance = Infinity;

        Object.entries(levels).forEach(([ratio, level]) => {
            const distance = Math.abs(currentPrice - level);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestLevel = { ratio: parseFloat(ratio), price: level };
            }

            if (level < currentPrice) {
                if (!support || level > levels[support]) {
                    support = ratio;
                }
            } else if (level > currentPrice) {
                if (!resistance || level < levels[resistance]) {
                    resistance = ratio;
                }
            }
        });

        const priceDeviation = (Math.abs(currentPrice - nearestLevel.price) / currentPrice) * 100;

        return {
            nearestLevel,
            support: support ? { ratio: parseFloat(support), price: levels[support] } : null,
            resistance: resistance ? { ratio: parseFloat(resistance), price: levels[resistance] } : null,
            priceDeviation,
            trend
        };
    }
}

// =============== POSITION MANAGEMENT ===============
class PositionManager {
    constructor() {
        this.config = CONFIG.RISK;
        this.activePosition = null;
    }

    calculatePositionParameters(signal, price, volatility) {
        const leverage = this.calculateDynamicLeverage(volatility, signal.confidence);
        const riskAmount = this.config.ACCOUNT_SIZE * this.config.RISK_PER_TRADE;
        const stopLossDistance = (volatility * this.config.STOP_LOSS_MULTIPLIER) / 100;
        const positionSize = Math.min(
            (riskAmount / stopLossDistance) * leverage,
            this.config.MAX_POSITION_SIZE
        );

        const isLong = signal.signal.includes('BUY');
        const stopLoss = isLong
            ? price * (1 - stopLossDistance)
            : price * (1 + stopLossDistance);

        const takeProfitDistance = stopLossDistance * this.config.TAKE_PROFIT_MULTIPLIER;
        const takeProfit = isLong
            ? price * (1 + takeProfitDistance)
            : price * (1 - takeProfitDistance);

        return {
            size: positionSize,
            leverage,
            entryPrice: price,
            stopLoss,
            takeProfit,
            direction: isLong ? 'LONG' : 'SHORT',
            timestamp: Date.now()
        };
    }

    calculateDynamicLeverage(volatility, confidence) {
        const volatilityFactor = Math.max(0.2, 1 - (volatility / 100));
        const confidenceMultiplier = {
            'HIGH': 1,
            'MEDIUM': 0.7,
            'LOW': 0.5
        }[confidence] || 0.5;

        return Math.min(
            Math.floor(this.config.BASE_LEVERAGE * volatilityFactor * confidenceMultiplier),
            this.config.MAX_LEVERAGE
        );
    }

    calculatePnL(currentPrice) {
        if (!this.activePosition) return 0;

        const { direction, entryPrice, leverage } = this.activePosition;
        const priceChange = direction === 'LONG'
            ? (currentPrice - entryPrice) / entryPrice
            : (entryPrice - currentPrice) / entryPrice;

        return priceChange * 100 * leverage;
    }

    checkStopLoss(currentPrice) {
        if (!this.activePosition) return false;

        const { direction, stopLoss } = this.activePosition;
        if (direction === 'LONG' && currentPrice <= stopLoss) return true;
        if (direction === 'SHORT' && currentPrice >= stopLoss) return true;
        return false;
    }

    checkTakeProfit(currentPrice) {
        if (!this.activePosition) return false;

        const { direction, takeProfit } = this.activePosition;
        if (direction === 'LONG' && currentPrice >= takeProfit) return true;
        if (direction === 'SHORT' && currentPrice <= takeProfit) return true;
        return false;
    }
}

// =============== TRADE EXECUTION ===============
class TradeExecutor {
    constructor(positionManager) {
        this.positionManager = positionManager;
        this.tracker = null;
    }

    shouldTrade(signal, marketState) {
        // Check if we already have a position
        if (this.positionManager.activePosition) {
            return false;
        }

        // Only trade on strong buy/sell signals, not watch signals
        if (!signal.signal.includes('STRONG_') && !signal.signal.includes('POTENTIAL_')) {
            return false;
        }

        // Check signal confidence
        const confidenceOrder = { 'LOW': 0, 'MEDIUM': 1, 'HIGH': 2 };
        const minConfidenceLevel = confidenceOrder[CONFIG.TRADING.MIN_CONFIDENCE] || 1;
        const signalConfidenceLevel = confidenceOrder[signal.confidence] || 0;

        if (signalConfidenceLevel < minConfidenceLevel) {
            return false;
        }

        // Check volatility conditions
        if (marketState.volatility < CONFIG.TRADING.MIN_VOLATILITY) {
            return false;
        }
        if (marketState.volatility > CONFIG.TRADING.MAX_VOLATILITY) {
            return false;
        }

        return true;
    }

    async executeTrade(signal, price, marketState) {
        // Check if we should actually trade based on signal
        if (!this.shouldTrade(signal, marketState)) {
            return;
        }

        if (this.positionManager.activePosition) {
            console.log('Already in position, skipping trade execution'.yellow);
            return;
        }

        const position = this.positionManager.calculatePositionParameters(
            signal,
            price,
            marketState.volatility
        );

        // Add unique ID to position
        position.id = `${this.tracker.symbol}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        this.logTradePlan(position);
        await this.executePosition(position);
    }

    async executePosition(position) {
        console.log(`${this.tracker.symbol}: Executing trade...`.green);

        this.positionManager.activePosition = position;

        // Add to trade history
        if (this.tracker && this.tracker.tradeHistoryManager) {
            await this.tracker.tradeHistoryManager.addTrade({
                ...position,
                status: 'OPEN'
            });
        }

        console.log(`${this.tracker.symbol}: Trade executed successfully`.green);
    }

    async closePosition(reason, price) {
        if (!this.positionManager.activePosition) return;

        console.log(`${this.tracker.symbol}: Closing position: ${reason}`.yellow);

        const pnl = this.positionManager.calculatePnL(price);
        const exitTime = Date.now();

        if (this.tracker && this.tracker.tradeHistoryManager) {
            const trades = this.tracker.tradeHistoryManager.getAllTrades();
            const lastTradeIndex = trades.findIndex(trade =>
                trade.status === 'OPEN' &&
                trade.id === this.positionManager.activePosition.id
            );

            if (lastTradeIndex >= 0) {
                await this.tracker.tradeHistoryManager.updateTrade(lastTradeIndex, {
                    status: 'CLOSED',
                    exitPrice: price,
                    pnl,
                    closeReason: reason,
                    exitTime
                });
            }
        }

        this.positionManager.activePosition = null;
        console.log(`${this.tracker.symbol}: Position closed with ${pnl.toFixed(2)}% PnL`.green);
    }

    async closeSpecificPosition(positionId, reason, price) {
        console.log(`${this.tracker.symbol}: Closing specific position: ${positionId} - ${reason}`.yellow);

        if (!this.tracker || !this.tracker.tradeHistoryManager) {
            return {
                success: false,
                message: 'Trade history manager not available'
            };
        }

        const trades = this.tracker.tradeHistoryManager.getAllTrades();
        const tradeIndex = trades.findIndex(trade => trade.id === positionId);

        if (tradeIndex === -1) {
            return {
                success: false,
                message: 'Position not found'
            };
        }

        const trade = trades[tradeIndex];
        if (trade.status === 'CLOSED') {
            return {
                success: false,
                message: 'Position already closed'
            };
        }

        const pnl = this.calculateTradePnL(trade, price);
        const exitTime = Date.now();

        await this.tracker.tradeHistoryManager.updateTrade(tradeIndex, {
            status: 'CLOSED',
            exitPrice: price,
            pnl,
            closeReason: reason,
            exitTime
        });

        if (this.positionManager.activePosition &&
            this.positionManager.activePosition.id === positionId) {
            this.positionManager.activePosition = null;
        }

        console.log(`${this.tracker.symbol}: Position ${positionId} closed with ${pnl.toFixed(2)}% PnL`.green);

        return {
            success: true,
            message: 'Position closed successfully',
            positionId,
            pnl,
            closingPrice: price
        };
    }

    async closeAllPositions(reason, price) {
        console.log(`${this.tracker.symbol}: Closing all positions: ${reason}`.yellow);

        if (!this.tracker || !this.tracker.tradeHistoryManager) {
            return {
                success: false,
                message: 'Trade history manager not available'
            };
        }

        const trades = this.tracker.tradeHistoryManager.getAllTrades();
        const openTrades = trades.filter(trade => trade.status === 'OPEN');

        if (openTrades.length === 0) {
            return {
                success: false,
                message: 'No open positions to close'
            };
        }

        const closedPositions = [];
        let totalPnL = 0;

        for (const trade of openTrades) {
            const pnl = this.calculateTradePnL(trade, price);
            const exitTime = Date.now();

            const tradeIndex = trades.findIndex(t => t.id === trade.id);
            await this.tracker.tradeHistoryManager.updateTrade(tradeIndex, {
                status: 'CLOSED',
                exitPrice: price,
                pnl,
                closeReason: reason,
                exitTime
            });

            closedPositions.push({
                id: trade.id,
                pnl,
                direction: trade.direction
            });
            totalPnL += pnl;
        }

        this.positionManager.activePosition = null;

        console.log(`${this.tracker.symbol}: Closed ${closedPositions.length} positions with total PnL: ${totalPnL.toFixed(2)}%`.green);

        return {
            success: true,
            message: `Closed ${closedPositions.length} positions`,
            closedPositions,
            totalPnL,
            closingPrice: price
        };
    }

    calculateTradePnL(trade, currentPrice) {
        const { direction, entryPrice, leverage } = trade;
        const priceChange = direction === 'LONG'
            ? (currentPrice - entryPrice) / entryPrice
            : (entryPrice - currentPrice) / entryPrice;

        return priceChange * 100 * leverage;
    }

    logTradePlan(position) {
        console.log(`\n${this.tracker.symbol} Trade Plan:`.cyan);
        console.log(`Direction: ${position.direction}`.cyan);
        console.log(`Size: ${position.size.toFixed(2)}`.cyan);
        console.log(`Leverage: ${position.leverage}x`.cyan);
        console.log(`Entry: ${position.entryPrice.toFixed(2)}`.cyan);
        console.log(`Stop Loss: ${position.stopLoss.toFixed(2)}`.cyan);
        console.log(`Take Profit: ${position.takeProfit.toFixed(2)}`.cyan);

        const riskAmount = Math.abs(position.entryPrice - position.stopLoss) * position.size;
        const potentialProfit = Math.abs(position.takeProfit - position.entryPrice) * position.size;
        const riskRewardRatio = potentialProfit / riskAmount;

        console.log('\nRisk Metrics:'.yellow);
        console.log(`Risk Amount: ${riskAmount.toFixed(2)}`.yellow);
        console.log(`Potential Profit: ${potentialProfit.toFixed(2)}`.yellow);
        console.log(`Risk/Reward Ratio: ${riskRewardRatio.toFixed(2)}`.yellow);
    }

    getTradeHistory() {
        if (!this.tracker || !this.tracker.tradeHistoryManager) {
            return [];
        }

        const trades = this.tracker.tradeHistoryManager.getAllTrades();
        return trades.map(trade => {
            const duration = trade.exitTime && trade.entryTime ?
                this.calculateDuration(trade.entryTime, trade.exitTime) :
                trade.entryTime ?
                    this.calculateDuration(trade.entryTime, new Date().toISOString()) :
                    'N/A';

            return {
                ...trade,
                duration
            };
        });
    }

    calculateDuration(startTime, endTime) {
        const start = new Date(startTime);
        const end = new Date(endTime);
        const diffMs = end - start;
        const diffMins = Math.floor(diffMs / 1000 / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffDays > 0) {
            return `${diffDays}d ${diffHours % 24}h`;
        } else if (diffHours > 0) {
            return `${diffHours}h ${diffMins % 60}m`;
        } else {
            return `${diffMins}m`;
        }
    }
}

// =============== SIGNAL GENERATOR ===============
class SignalGenerator {
    static analyze(price, timeframes, currentPosition) {
        const signals = {};
        let volumeConfirmed = false;

        for (const [interval, data] of Object.entries(timeframes)) {
            const marketData = data.getData();
            const fibLevels = TechnicalAnalysis.calculateFibonacciLevels(marketData.prices);
            const fibAnalysis = TechnicalAnalysis.analyzeFibonacciSignals(price, fibLevels);

            signals[interval] = {
                vwma: TechnicalAnalysis.calculateVWMA(
                    marketData.prices,
                    marketData.volumes,
                    data.period
                ),
                rsi: TechnicalAnalysis.calculateRSI(marketData.prices),
                volume: TechnicalAnalysis.analyzeVolume(marketData.volumes),
                fibonacci: fibAnalysis
            };

            if (signals[interval].volume && signals[interval].volume.increasing) {
                volumeConfirmed = true;
            }
        }

        if (currentPosition) {
            const exitSignal = this.checkExitSignals(price, signals, currentPosition);
            if (exitSignal) return exitSignal;
        }

        return this.generateEntrySignal(price, signals, volumeConfirmed);
    }

    static checkExitSignals(price, signals, position) {
        const rsi15m = signals['15m'].rsi;
        const rsi1h = signals['1h'].rsi;
        const above15mMA = price > signals['15m'].vwma;
        const above1hMA = price > signals['1h'].vwma;

        if (position.direction === 'LONG') {
            if (rsi15m > 80 && rsi1h > 75) {
                return {
                    signal: 'CLOSE_LONG',
                    confidence: 'HIGH',
                    reason: 'Overbought conditions on both timeframes'
                };
            }
            if (!above15mMA && !above1hMA) {
                return {
                    signal: 'CLOSE_LONG',
                    confidence: 'HIGH',
                    reason: 'Price below both MAs'
                };
            }
        } else {
            if (rsi15m < 20 && rsi1h < 25) {
                return {
                    signal: 'CLOSE_SHORT',
                    confidence: 'HIGH',
                    reason: 'Oversold conditions on both timeframes'
                };
            }
            if (above15mMA && above1hMA) {
                return {
                    signal: 'CLOSE_SHORT',
                    confidence: 'HIGH',
                    reason: 'Price above both MAs'
                };
            }
        }

        return null;
    }

    static generateEntrySignal(price, signals, volumeConfirmed) {
        const above15mMA = price > signals['15m'].vwma;
        const above1hMA = price > signals['1h'].vwma;
        const rsi15m = signals['15m'].rsi;
        const rsi1h = signals['1h'].rsi;
        const fib15m = signals['15m'].fibonacci;
        const fib1h = signals['1h'].fibonacci;

        if (above15mMA && above1hMA && volumeConfirmed) {
            if (rsi15m < 70 && rsi1h < 70) {
                const nearSupport = (fib15m?.priceDeviation < 1 && fib15m?.nearestLevel?.ratio < 0.5) ||
                    (fib1h?.priceDeviation < 1 && fib1h?.nearestLevel?.ratio < 0.5);

                return {
                    signal: nearSupport ? 'STRONG_BUY' : 'POTENTIAL_BUY',
                    confidence: nearSupport ? 'HIGH' : 'MEDIUM',
                    reason: nearSupport ?
                        'Price above MAs with Fibonacci support' :
                        'Price above MAs without clear Fibonacci support'
                };
            }
        }

        if (!above15mMA && !above1hMA && volumeConfirmed) {
            if (rsi15m > 30 && rsi1h > 30) {
                const nearResistance = (fib15m?.priceDeviation < 1 && fib15m?.nearestLevel?.ratio > 0.5) ||
                    (fib1h?.priceDeviation < 1 && fib1h?.nearestLevel?.ratio > 0.5);

                return {
                    signal: nearResistance ? 'STRONG_SELL' : 'POTENTIAL_SELL',
                    confidence: nearResistance ? 'HIGH' : 'MEDIUM',
                    reason: nearResistance ?
                        'Price below MAs with Fibonacci resistance' :
                        'Price below MAs without clear Fibonacci resistance'
                };
            }
        }

        if (!above15mMA && above1hMA && volumeConfirmed) {
            if (rsi15m > 30) {
                return {
                    signal: 'POTENTIAL_SELL',
                    confidence: 'MEDIUM',
                    reason: 'Short-term downward momentum with volume support'
                };
            }
        }

        if (rsi15m <= 30 && rsi1h <= 30) {
            return {
                signal: 'WATCH_BUY',
                confidence: 'MEDIUM',
                reason: 'Oversold conditions on both timeframes'
            };
        }

        if (rsi15m >= 70 && rsi1h >= 70) {
            return {
                signal: 'WATCH_SELL',
                confidence: 'MEDIUM',
                reason: 'Overbought conditions on both timeframes'
            };
        }

        return {
            signal: 'NEUTRAL',
            confidence: 'LOW',
            reason: 'No clear trend or volume confirmation'
        };
    }
}

// =============== SIGNAL HISTORY MANAGER ===============
class SignalHistoryManager {
    constructor(pair) {
        this.pair = pair;
        this.historyFile = path.join(__dirname, `signal_history_${pair}.json`);
        this.signals = [];
        this.maxSignals = 1000;
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.historyFile, 'utf8');
            this.signals = JSON.parse(data);
            console.log(`Loaded ${this.signals.length} historical signals for ${this.pair}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveSignals();
                console.log(`Created new signal history file for ${this.pair}`);
            } else {
                console.error(`Error loading signal history for ${this.pair}:`, error);
            }
        }
    }

    async saveSignals() {
        try {
            // Comment out to prevent file operations during demo
            // await fs.writeFile(this.historyFile, JSON.stringify(this.signals, null, 2));
        } catch (error) {
            console.error(`Error saving signal history for ${this.pair}:`, error);
        }
    }

    async addSignal(signal, price, marketState) {
        const signalRecord = {
            timestamp: Date.now(),
            time: new Date().toISOString(),
            signal: signal.signal,
            confidence: signal.confidence,
            reason: signal.reason,
            price: price,
            volatility: marketState.volatility,
            pair: this.pair
        };

        this.signals.push(signalRecord);

        if (this.signals.length > this.maxSignals) {
            this.signals = this.signals.slice(-this.maxSignals);
        }

        await this.saveSignals();
        return signalRecord;
    }

    getRecentSignals(limit = 50) {
        return this.signals.slice(-limit);
    }

    getAllSignals() {
        return this.signals;
    }

    getSignalsByType(type, limit = 50) {
        return this.signals
            .filter(signal => signal.signal.includes(type))
            .slice(-limit);
    }

    getSignalsByTimeRange(startTime, endTime) {
        return this.signals.filter(signal => {
            const signalTime = new Date(signal.timestamp).getTime();
            return signalTime >= startTime && signalTime <= endTime;
        });
    }

    getSignalStats() {
        const buySignals = this.signals.filter(s =>
            s.signal.includes('BUY') || s.signal.includes('LONG'));
        const sellSignals = this.signals.filter(s =>
            s.signal.includes('SELL') || s.signal.includes('SHORT'));

        return {
            totalSignals: this.signals.length,
            buySignals: buySignals.length,
            sellSignals: sellSignals.length,
            recentSignals: this.getRecentSignals(10)
        };
    }
}

// =============== TRADE HISTORY MANAGER ===============
class TradeHistoryManager {
    constructor(pair) {
        this.pair = pair;
        this.historyFile = path.join(__dirname, `trade_history_${pair}.json`);
        this.trades = [];
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.historyFile, 'utf8');
            this.trades = JSON.parse(data);
            console.log(`Loaded ${this.trades.length} historical trades for ${this.pair}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveTrades();
            } else {
                console.error(`Error loading trade history for ${this.pair}:`, error);
            }
        }
    }

    async saveTrades() {
        try {
            await fs.writeFile(this.historyFile, JSON.stringify(this.trades, null, 2));
        } catch (error) {
            console.error(`Error saving trade history for ${this.pair}:`, error);
        }
    }

    async addTrade(trade) {
        const tradeWithTimestamp = {
            ...trade,
            id: trade.id || `${this.pair}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            pair: this.pair,
            timestamp: trade.timestamp || Date.now(),
            entryTime: new Date(trade.timestamp || Date.now()).toISOString(),
            exitTime: trade.exitTime ? new Date(trade.exitTime).toISOString() : null
        };
        this.trades.push(tradeWithTimestamp);
        await this.saveTrades();
        return tradeWithTimestamp;
    }

    async updateTrade(index, updates) {
        if (index >= 0 && index < this.trades.length) {
            this.trades[index] = {
                ...this.trades[index],
                ...updates,
                exitTime: updates.exitTime ? new Date(updates.exitTime).toISOString() : null
            };
            await this.saveTrades();
        }
    }

    getRecentTrades(limit = 50) {
        return this.trades.slice(-limit);
    }

    getAllTrades() {
        return this.trades;
    }

    getTradeStatistics() {
        const closedTrades = this.trades.filter(t => t.status === 'CLOSED');
        const openTrades = this.trades.filter(t => t.status === 'OPEN');

        if (closedTrades.length === 0) {
            return {
                totalTrades: 0,
                openTrades: openTrades.length,
                winRate: 0,
                avgWin: 0,
                avgLoss: 0,
                totalPnL: 0,
                totalWinningTrades: 0,
                totalLosingTrades: 0,
                bestTrade: null,
                worstTrade: null,
                largestWin: 0,
                largestLoss: 0,
                avgTradeDuration: 0,
                profitFactor: 0,
                maxDrawdown: 0
            };
        }

        const winningTrades = closedTrades.filter(t => t.pnl > 0);
        const losingTrades = closedTrades.filter(t => t.pnl < 0);
        const breakEvenTrades = closedTrades.filter(t => t.pnl === 0);

        const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
        const winRate = (winningTrades.length / closedTrades.length) * 100;

        const avgWin = winningTrades.length > 0 ?
            winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ?
            losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;

        const largestWin = winningTrades.length > 0 ?
            Math.max(...winningTrades.map(t => t.pnl)) : 0;
        const largestLoss = losingTrades.length > 0 ?
            Math.min(...losingTrades.map(t => t.pnl)) : 0;

        const totalWins = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

        const tradesWithDuration = closedTrades.filter(t => t.entryTime && t.exitTime);
        const avgTradeDuration = tradesWithDuration.length > 0 ?
            tradesWithDuration.reduce((sum, t) => {
                const duration = new Date(t.exitTime) - new Date(t.entryTime);
                return sum + duration;
            }, 0) / tradesWithDuration.length : 0;

        let maxDrawdown = 0;
        let peak = 0;
        let runningTotal = 0;

        closedTrades.forEach(trade => {
            runningTotal += trade.pnl;
            if (runningTotal > peak) {
                peak = runningTotal;
            }
            const drawdown = peak - runningTotal;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        });

        return {
            totalTrades: closedTrades.length,
            openTrades: openTrades.length,
            winRate: winRate,
            avgWin: avgWin,
            avgLoss: avgLoss,
            totalPnL: totalPnL,
            totalWinningTrades: winningTrades.length,
            totalLosingTrades: losingTrades.length,
            breakEvenTrades: breakEvenTrades.length,
            bestTrade: [...closedTrades].sort((a, b) => b.pnl - a.pnl)[0],
            worstTrade: [...closedTrades].sort((a, b) => a.pnl - b.pnl)[0],
            largestWin: largestWin,
            largestLoss: largestLoss,
            avgTradeDuration: avgTradeDuration,
            profitFactor: profitFactor,
            maxDrawdown: maxDrawdown,
            totalWins: totalWins,
            totalLosses: totalLosses
        };
    }
}

// =============== MAIN TRACKER CLASS ===============
class FuturesTracker {
    constructor(symbol) {
        this.symbol = symbol;
        this.timeframes = {};
        this.lastSignal = { signal: 'NEUTRAL', confidence: 'LOW', reason: 'Initializing...' };

        for (const [interval] of Object.entries(CONFIG.TIMEFRAMES)) {
            this.timeframes[interval] = new MarketData(interval);
        }

        this.positionManager = new PositionManager();
        this.tradeExecutor = new TradeExecutor(this.positionManager);
        this.rateLimiter = new RateLimiter(CONFIG.SYSTEM.API_RATE_LIMIT);
        this.currentPrice = null;
        this.tradeExecutor.tracker = this;
        this.signalHistoryManager = new SignalHistoryManager(symbol);
        this.tradeHistoryManager = new TradeHistoryManager(symbol);
    }

    async start() {
        try {
            console.log(`Starting Futures Trading Bot for ${this.symbol}...`.green);
            await this.fetchHistoricalData();
            this.startWebSocket();
            this.startUpdates();
            await this.signalHistoryManager.initialize();
            await this.tradeHistoryManager.initialize();
        } catch (error) {
            console.error(`Failed to start tracker for ${this.symbol}:`.red, error);
            throw error;
        }
    }

    async fetchHistoricalData() {
        console.log(`Fetching historical data for ${this.symbol}...`.yellow);
        try {
            await Promise.all(
                Object.entries(this.timeframes).map(([interval]) =>
                    this.fetchIntervalData(interval)
                )
            );
            console.log(`Historical data loaded successfully for ${this.symbol}`.green);
        } catch (error) {
            throw new TradingError(`Historical data fetch failed for ${this.symbol}`, 'FETCH_ERROR', true);
        }
    }

    async fetchIntervalData(interval) {
        await this.rateLimiter.throttle();

        try {
            const response = await axios.get('https://api.binance.com/api/v3/klines', {
                params: {
                    symbol: this.symbol.toUpperCase(),
                    interval: interval,
                    limit: CONFIG.BUFFER_SIZE
                }
            });

            response.data.forEach(k => {
                this.timeframes[interval].addCandle(
                    parseFloat(k[4]), // close price
                    parseFloat(k[5]), // volume
                    new Date(k[0])    // timestamp
                );
            });
        } catch (error) {
            throw new TradingError(
                `Failed to fetch ${interval} data for ${this.symbol}: ${error.message}`,
                'INTERVAL_FETCH_ERROR',
                true
            );
        }
    }

    startWebSocket() {
        console.log(`Initializing WebSocket connection for ${this.symbol}...`.yellow);
        const streams = Object.keys(this.timeframes)
            .map(interval => `${this.symbol.toLowerCase()}@kline_${interval}`)
            .join('/');

        const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
        const ws = new WebSocket(wsUrl);

        // Store WebSocket reference
        globalWebSocket.set(this.symbol, ws);

        ws.on('open', () => console.log(`WebSocket Connected for ${this.symbol}`.green));

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                if (message.data?.k) {
                    this.handleKline(message.data.k);
                }
            } catch (error) {
                console.error(`WebSocket message error for ${this.symbol}:`.red, error);
            }
        });

        ws.on('close', () => {
            console.log(`WebSocket disconnected for ${this.symbol}, reconnecting...`.yellow);
            setTimeout(() => this.startWebSocket(), CONFIG.SYSTEM.RETRY_DELAY);
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error for ${this.symbol}:`.red, error);
        });
    }

    handleKline(kline) {
        const price = parseFloat(kline.c);
        const volume = parseFloat(kline.v);
        const time = new Date(kline.t);
        const interval = kline.i;

        if (kline.x) { // Candle closed
            this.timeframes[interval].addCandle(price, volume, time);
        }

        this.currentPrice = price;
        this.checkForSignals();

        if (this.positionManager.activePosition) {
            if (this.positionManager.checkStopLoss(price)) {
                this.tradeExecutor.closePosition('Stop Loss hit', price);
            } else if (this.positionManager.checkTakeProfit(price)) {
                this.tradeExecutor.closePosition('Take Profit hit', price);
            }
        }
    }

    checkForSignals() {
        const marketState = this.getMarketState();

        const signal = SignalGenerator.analyze(
            this.currentPrice,
            this.timeframes,
            this.positionManager.activePosition
        );

        this.lastSignal = signal;

        if (this.signalHistoryManager) {
            this.signalHistoryManager.addSignal(signal, this.currentPrice, marketState);
        }

        // Only execute trades on valid signals with proper conditions
        if (this.tradeExecutor.shouldTrade(signal, marketState)) {
            console.log(`${this.symbol}: Valid trading signal detected - ${signal.signal}`.green);
            this.tradeExecutor.executeTrade(signal, this.currentPrice, marketState);
        }
    }

    getMarketState() {
        const volatilities = Object.entries(this.timeframes).map(([interval, data]) => {
            const { prices } = data.getData();
            return TechnicalAnalysis.calculateVolatility(prices);
        });

        return {
            volatility: Math.max(...volatilities),
            timestamp: Date.now()
        };
    }

    getDashboardData() {
        const positionStatus = this.positionManager.activePosition ? {
            status: 'IN_POSITION',
            direction: this.positionManager.activePosition.direction,
            size: this.positionManager.activePosition.size,
            entryPrice: this.positionManager.activePosition.entryPrice,
            stopLoss: this.positionManager.activePosition.stopLoss,
            takeProfit: this.positionManager.activePosition.takeProfit,
            leverage: this.positionManager.activePosition.leverage,
            duration: this.calculatePositionDuration()
        } : { status: 'NO_POSITION', message: 'No active position' };

        return {
            pair: this.symbol,
            price: this.currentPrice,
            signal: this.lastSignal,
            timeframes: Object.fromEntries(
                Object.entries(this.timeframes).map(([interval, data]) => {
                    const { prices, volumes } = data.getData();
                    const fibLevels = TechnicalAnalysis.calculateFibonacciLevels(prices);

                    return [interval, {
                        vwma: TechnicalAnalysis.calculateVWMA(prices, volumes, data.period),
                        rsi: TechnicalAnalysis.calculateRSI(prices),
                        volatility: TechnicalAnalysis.calculateVolatility(prices),
                        volume: TechnicalAnalysis.analyzeVolume(volumes),
                        fibonacci: TechnicalAnalysis.analyzeFibonacciSignals(this.currentPrice, fibLevels)
                    }];
                })
            ),
            position: positionStatus.status === 'IN_POSITION' ? {
                ...positionStatus,
                size: typeof positionStatus.size === 'number' ? Number(positionStatus.size) : 0,
                pnl: this.positionManager.calculatePnL(this.currentPrice)
            } : positionStatus,
            performance: this.tradeExecutor.getTradeHistory(),
            signalHistory: this.signalHistoryManager.getRecentSignals(20),
            performanceStats: this.tradeHistoryManager.getTradeStatistics(),
            openPositions: this.tradeHistoryManager.getAllTrades()
                .filter(trade => trade.status === 'OPEN')
                .map(trade => ({
                    ...trade,
                    currentPnL: this.tradeExecutor.calculateTradePnL(trade, this.currentPrice)
                }))
        };
    }

    startUpdates() {
        setInterval(() => {
            this.checkForSignals();

            // Send data to dashboard for this specific pair
            const dashboardData = this.getDashboardData();
            io.to(this.symbol).emit('marketUpdate', dashboardData);

        }, CONFIG.SYSTEM.UPDATE_INTERVAL);
    }

    calculatePositionDuration() {
        if (!this.positionManager.activePosition || !this.positionManager.activePosition.timestamp) {
            return 'N/A';
        }

        const entryTime = new Date(this.positionManager.activePosition.timestamp);
        const now = new Date();
        const diffMs = now - entryTime;
        const diffMins = Math.floor(diffMs / 1000 / 60);
        const diffHours = Math.floor(diffMins / 60);

        if (diffHours > 0) {
            return `${diffHours}h ${diffMins % 60}m`;
        } else {
            return `${diffMins}m`;
        }
    }
}

// =============== SERVER STARTUP ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multi-Pair Trading Dashboard available at http://localhost:${PORT}`.green);
    console.log(`Available endpoints:`.cyan);
    console.log(`  GET  /pairs - Get available trading pairs`.cyan);
    console.log(`  POST /start-pair/:pair - Start tracking a pair`.cyan);
    console.log(`  POST /stop-pair/:pair - Stop tracking a pair`.cyan);
    console.log(`  GET  /active-pairs - Get currently tracked pairs`.cyan);
    console.log(`  POST /trade/:pair - Place manual trade`.cyan);
    console.log(`  POST /close/:pair - Close position for pair`.cyan);
    console.log(`  POST /close/:pair/:id - Close specific position`.cyan);
    console.log(`  POST /close-all/:pair - Close all positions for pair`.cyan);
    console.log(`\nTo start trading, open your browser and select a pair from the dashboard.`.yellow);
});

// System ready message
console.log(`System ready. Visit http://localhost:${PORT} to start trading.`.green);
