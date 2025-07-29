const WebSocket = require('ws');
const axios = require('axios');
const colors = require('colors');  // For console coloring
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const path = require('path');

// =============== CONFIGURATION ===============
const CONFIG = {
    // Market Data Config
    SYMBOL: 'adausdt',
    TIMEFRAMES: {
        '15m': { period: 9 },   // 9 MA for shorter timeframe
        '1h': { period: 21 }    // 21 MA for longer timeframe
    },
    BUFFER_SIZE: 100,           // How many candles to store

    // Risk Management
    RISK: {
        ACCOUNT_SIZE: 10000,    // Starting capital
        RISK_PER_TRADE: 0.02,   // 2% risk per trade
        MAX_POSITION_SIZE: 1000, // Maximum position size in USD
        BASE_LEVERAGE: 10,      // Default leverage
        MAX_LEVERAGE: 20,       // Maximum allowed leverage
        STOP_LOSS_MULTIPLIER: 1.5,  // SL distance based on volatility
        TAKE_PROFIT_MULTIPLIER: 3,  // TP distance as multiple of SL
    },

    // Trading Rules
    TRADING: {
        MIN_VOLATILITY: 5,      // Minimum volatility to trade
        MAX_VOLATILITY: 50,     // Maximum volatility to trade
        VOLUME_THRESHOLD: 1.2,   // Volume increase required for trade
        MIN_CONFIDENCE: 'MEDIUM' // Minimum signal confidence
    },

    // Technical Settings
    TECHNICAL: {
        RSI_PERIOD: 14,
        VOLATILITY_PERIOD: 20,
        VOLUME_MA_PERIOD: 20
    },

    // System Settings
    SYSTEM: {
        RETRY_DELAY: 1000,      // WebSocket reconnection delay
        UPDATE_INTERVAL: 1000,   // Console update interval
        MAX_RETRIES: 3,         // Maximum WebSocket reconnection attempts
        API_RATE_LIMIT: 1200    // API rate limit per minute
    }
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Manual trade endpoint
app.post('/trade', (req, res) => {
    const { type, size, leverage } = req.body;

    if (!tracker.currentPrice) {
        return res.json({ success: false, message: 'Price not available' });
    }

    // Simulate a manual trade
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
    if (size) position.size = size;
    if (leverage) position.leverage = leverage;

    // Execute the trade
    tracker.tradeExecutor.executeTrade(position);

    res.json({
        success: true,
        message: `Manual ${type} position opened`,
        position
    });
});

// Close position endpoint
app.post('/close', async (req, res) => {
    try {
        const { reason = 'Manual close' } = req.body;

        // Check if there's an active position
        if (!tracker.positionManager.activePosition) {
            return res.status(400).json({
                success: false,
                message: 'No active position to close'
            });
        }

        // Get current price
        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        // Close the position
        await tracker.tradeExecutor.closePosition(reason, tracker.currentPrice);

        // Return success response
        res.json({
            success: true,
            message: 'Position closed successfully',
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
app.post('/close/:positionId', async (req, res) => {
    try {
        const { positionId } = req.params;
        const { reason = 'Manual close' } = req.body;

        // Get current price
        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        // Close the specific position
        const result = await tracker.tradeExecutor.closeSpecificPosition(positionId, reason, tracker.currentPrice);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);

    } catch (error) {
        console.error('Error closing specific position:', error);
        res.status(500).json({
            success: false,
            message: `Failed to close position: ${error.message}`
        });
    }
});

// Close all positions endpoint
app.post('/close-all', async (req, res) => {
    try {
        const { reason = 'Close all positions' } = req.body;

        // Get current price
        if (!tracker.currentPrice) {
            return res.status(400).json({
                success: false,
                message: 'Current price not available'
            });
        }

        // Close all positions
        const result = await tracker.tradeExecutor.closeAllPositions(reason, tracker.currentPrice);

        res.json(result);

    } catch (error) {
        console.error('Error closing all positions:', error);
        res.status(500).json({
            success: false,
            message: `Failed to close all positions: ${error.message}`
        });
    }
});

// Get enhanced performance statistics
app.get('/performance', (req, res) => {
    try {
        const stats = tracker.tradeHistoryManager.getTradeStatistics();
        const signalStats = tracker.signalHistoryManager.getSignalStats();

        res.json({
            success: true,
            tradeStats: stats,
            signalStats: signalStats
        });
    } catch (error) {
        console.error('Error getting performance stats:', error);
        res.status(500).json({
            success: false,
            message: `Failed to get performance stats: ${error.message}`
        });
    }
});

// =============== ERROR HANDLING ===============
class TradingError extends Error {
    constructor(message, code, retryable = false) {
        super(message);
        this.name = 'TradingError';
        this.code = code;
        this.retryable = retryable;
    }
}

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

// Will continue with the rest of the code in subsequent parts...

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
    // Volume Weighted Moving Average
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

    // Relative Strength Index
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

    // Historical Volatility
    static calculateVolatility(prices, period = CONFIG.TECHNICAL.VOLATILITY_PERIOD) {
        if (prices.length < period + 1) return 0;

        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }

        const sumSquared = returns.reduce((sum, ret) => sum + ret * ret, 0);
        return Math.sqrt(sumSquared / period) * 100;
    }

    // Volume Analysis
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

    // Trend Analysis
    static analyzeTrend(currentPrice, vwma15m, vwma1h, rsi15m, rsi1h) {
        const above15m = currentPrice > vwma15m;
        const above1h = currentPrice > vwma1h;

        if (above15m && above1h) {
            if (rsi15m < 70 && rsi1h < 70) return 'STRONG_UPTREND';
            return 'OVERBOUGHT';
        }

        if (!above15m && !above1h) {
            if (rsi15m > 30 && rsi1h > 30) return 'STRONG_DOWNTREND';
            return 'OVERSOLD';
        }

        if (above15m && !above1h) return 'POTENTIAL_REVERSAL_UP';
        return 'POTENTIAL_REVERSAL_DOWN';
    }


    // Fibonacci
    static calculateFibonacciLevels(prices, lookbackPeriod = 20) {
        if (prices.length < lookbackPeriod) return null;

        // Get relevant price segment
        const recentPrices = prices.slice(-lookbackPeriod);

        // Find swing high and low
        const high = Math.max(...recentPrices);
        const low = Math.min(...recentPrices);

        // Common Fibonacci ratios
        const ratios = {
            '0': 0,
            '0.236': 0.236,
            '0.382': 0.382,
            '0.5': 0.5,
            '0.618': 0.618,
            '0.786': 0.786,
            '1': 1
        };

        // Calculate levels for both uptrend and downtrend
        const isUptrend = recentPrices[recentPrices.length - 1] > recentPrices[0];
        const levels = {};

        if (isUptrend) {
            // Calculate retracement levels from high to low
            Object.entries(ratios).forEach(([key, ratio]) => {
                levels[key] = high - (high - low) * ratio;
            });
        } else {
            // Calculate retracement levels from low to high
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

        // Find nearest Fibonacci level and setup support/resistance
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

        // Calculate price position relative to nearest level
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

// Will continue with position management and trade execution...


// =============== POSITION MANAGEMENT ===============
class PositionManager {
    constructor() {
        this.config = CONFIG.RISK;
        this.activePosition = null;
    }

    calculatePositionParameters(signal, price, volatility) {
        // Calculate dynamic leverage based on market conditions
        const leverage = this.calculateDynamicLeverage(volatility, signal.confidence);

        // Calculate position size based on risk parameters
        const riskAmount = this.config.ACCOUNT_SIZE * this.config.RISK_PER_TRADE;
        const stopLossDistance = (volatility * this.config.STOP_LOSS_MULTIPLIER) / 100;
        const positionSize = Math.min(
            (riskAmount / stopLossDistance) * leverage,
            this.config.MAX_POSITION_SIZE
        );

        // Determine position direction
        const isLong = signal.signal.includes('BUY');

        // Calculate entry, stop loss, and take profit levels
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
        // Reduce leverage as volatility increases
        const volatilityFactor = Math.max(0.2, 1 - (volatility / 100));

        // Adjust based on signal confidence
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
        this.tradeHistory = [];
        this.tracker = null;
    }

    async executeTrade(signal, price, marketState) {
        if (this.positionManager.activePosition) {
            console.log('Already in position, skipping trade execution'.yellow);
            return;
        }

        // Calculate position parameters
        const position = this.positionManager.calculatePositionParameters(
            signal,
            price,
            marketState.volatility
        );

        // Log trade plan
        this.logTradePlan(position);

        // Execute the trade
        await this.executeTrade(position);
    }

    shouldTrade(signal, marketState) {
        // Check if we already have a position
        if (this.positionManager.activePosition) {
            console.log('Already in position, skipping signal'.gray);
            return false;
        }

        // Check signal confidence
        if (signal.confidence < this.config.MIN_CONFIDENCE) {
            console.log('Signal confidence too low'.gray);
            return false;
        }

        // Check volatility conditions
        if (marketState.volatility < this.config.MIN_VOLATILITY) {
            console.log('Volatility too low'.gray);
            return false;
        }
        if (marketState.volatility > this.config.MAX_VOLATILITY) {
            console.log('Volatility too high'.gray);
            return false;
        }

        return true;
    }

    async executeTrade(position) {
        // Here you would integrate with your exchange's API
        console.log('Executing trade...'.green);

        // Simulate trade execution
        this.positionManager.activePosition = position;
        this.tradeHistory.push({
            ...position,
            status: 'OPEN'
        });

        console.log('Trade executed successfully'.green);
    }

    async closePosition(reason, price) {
        if (!this.positionManager.activePosition) return;

        console.log(`\nClosing position: ${reason}`.yellow);

        // Calculate PnL
        const pnl = this.positionManager.calculatePnL(price);
        const exitTime = Date.now();

        // Find the most recent open trade
        if (this.tracker && this.tracker.tradeHistoryManager) {
            const trades = this.tracker.tradeHistoryManager.getAllTrades();
            const openTrades = trades.filter(trade => trade.status === 'OPEN');
            const lastTradeIndex = trades.findIndex(trade => trade.id === this.positionManager.activePosition.id);

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

        // Clear active position
        this.positionManager.activePosition = null;

        console.log(`Position closed with ${pnl.toFixed(2)}% PnL`.green);
    }

    async closeSpecificPosition(positionId, reason, price) {
        console.log(`\nClosing specific position: ${positionId} - ${reason}`.yellow);

        // Find the trade by ID
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

        // Calculate PnL
        const pnl = this.calculateTradePnL(trade, price);
        const exitTime = Date.now();

        // Update the trade
        await this.tracker.tradeHistoryManager.updateTrade(tradeIndex, {
            status: 'CLOSED',
            exitPrice: price,
            pnl,
            closeReason: reason,
            exitTime
        });

        // If this was the active position, clear it
        if (this.positionManager.activePosition &&
            this.positionManager.activePosition.id === positionId) {
            this.positionManager.activePosition = null;
        }

        console.log(`Position ${positionId} closed with ${pnl.toFixed(2)}% PnL`.green);

        return {
            success: true,
            message: 'Position closed successfully',
            positionId,
            pnl,
            closingPrice: price
        };
    }

    async closeAllPositions(reason, price) {
        console.log(`\nClosing all positions: ${reason}`.yellow);

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

        // Clear active position
        this.positionManager.activePosition = null;

        console.log(`Closed ${closedPositions.length} positions with total PnL: ${totalPnL.toFixed(2)}%`.green);

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
        console.log('\nTrade Plan:'.cyan);
        console.log(`Direction: ${position.direction}`.cyan);
        console.log(`Size: $${position.size.toFixed(2)}`.cyan);
        console.log(`Leverage: ${position.leverage}x`.cyan);
        console.log(`Entry: $${position.entryPrice.toFixed(2)}`.cyan);
        console.log(`Stop Loss: $${position.stopLoss.toFixed(2)}`.cyan);
        console.log(`Take Profit: $${position.takeProfit.toFixed(2)}`.cyan);

        // Calculate risk metrics
        const riskAmount = Math.abs(position.entryPrice - position.stopLoss) * position.size;
        const potentialProfit = Math.abs(position.takeProfit - position.entryPrice) * position.size;
        const riskRewardRatio = potentialProfit / riskAmount;

        console.log('\nRisk Metrics:'.yellow);
        console.log(`Risk Amount: $${riskAmount.toFixed(2)}`.yellow);
        console.log(`Potential Profit: $${potentialProfit.toFixed(2)}`.yellow);
        console.log(`Risk/Reward Ratio: ${riskRewardRatio.toFixed(2)}`.yellow);
    }

    getStatusReport() {
        if (!this.positionManager.activePosition) {
            return {
                status: 'NO_POSITION',
                message: 'No active position'
            };
        }

        const position = this.positionManager.activePosition;
        const duration = Date.now() - position.timestamp;
        const durationHours = (duration / (1000 * 60 * 60)).toFixed(1);

        return {
            status: 'IN_POSITION',
            direction: position.direction,
            size: position.size,
            leverage: position.leverage,
            entryPrice: position.entryPrice,
            stopLoss: position.stopLoss,
            takeProfit: position.takeProfit,
            duration: `${durationHours}h`
        };
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

    printPerformanceReport() {
        const closedTrades = this.tradeHistory.filter(t => t.status === 'CLOSED');

        if (closedTrades.length === 0) {
            console.log('\nNo closed trades yet'.gray);
            return;
        }

        const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
        const winningTrades = closedTrades.filter(t => t.pnl > 0);
        const losingTrades = closedTrades.filter(t => t.pnl < 0);
        const winRate = (winningTrades.length / closedTrades.length) * 100;

        const avgWin = winningTrades.length > 0 ?
            winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ?
            losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;

        console.log('\nPerformance Report:'.cyan);
        console.log(`Total Trades: ${closedTrades.length}`.cyan);
        console.log(`Winning Trades: ${winningTrades.length}`.green);
        console.log(`Losing Trades: ${losingTrades.length}`.red);
        console.log(`Win Rate: ${winRate.toFixed(2)}%`.cyan);
        console.log(`Average Win: ${avgWin.toFixed(2)}%`.green);
        console.log(`Average Loss: ${avgLoss.toFixed(2)}%`.red);
        console.log(`Total PnL: ${totalPnL.toFixed(2)}%`.cyan);
    }
}

// =============== SIGNAL GENERATOR ===============
class SignalGenerator {
    static analyze(price, timeframes, currentPosition) {
        const signals = {};
        let volumeConfirmed = false;

        // Calculate technical indicators for each timeframe
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

            if (signals[interval].volume.increasing) {
                volumeConfirmed = true;
            }
        }

        // Check for exit signals if in position
        if (currentPosition) {
            const exitSignal = this.checkExitSignals(price, signals, currentPosition);
            if (exitSignal) return exitSignal;
        }

        // Generate entry signals using VWMA crossovers and RSI
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
            // Add MA crossover exit
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
            // Add MA crossover exit
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

        // Strong buy signal
        if (above15mMA && above1hMA && volumeConfirmed) {
            if (rsi15m < 70 && rsi1h < 70) {
                // Check if price is near a Fibonacci support level
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

        // Strong sell signal
        if (!above15mMA && !above1hMA && volumeConfirmed) {
            if (rsi15m > 30 && rsi1h > 30) {
                return {
                    signal: 'STRONG_SELL',
                    confidence: 'HIGH',
                    reason: 'Price below both MAs with volume confirmation'
                };
            }
        }

        // Potential buy signal - 15m above, 1h below (potential upward reversal)
        if (!above15mMA && !above1hMA && volumeConfirmed) {
            if (rsi15m > 30 && rsi1h > 30) {
                // Check if price is near a Fibonacci resistance level
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

        // Potential sell signal - 15m below, 1h above (potential downward reversal)
        if (!above15mMA && above1hMA && volumeConfirmed) {
            if (rsi15m > 30) {
                return {
                    signal: 'POTENTIAL_SELL',
                    confidence: 'MEDIUM',
                    reason: 'Short-term downward momentum with volume support'
                };
            }
        }

        // Oversold conditions - potential buy opportunity
        if (rsi15m <= 30 && rsi1h <= 30) {
            return {
                signal: 'WATCH_BUY',
                confidence: 'MEDIUM',
                reason: 'Oversold conditions on both timeframes'
            };
        }

        // Overbought conditions - potential sell opportunity
        if (rsi15m >= 70 && rsi1h >= 70) {
            return {
                signal: 'WATCH_SELL',
                confidence: 'MEDIUM',
                reason: 'Overbought conditions on both timeframes'
            };
        }

        // No clear signal
        return {
            signal: 'NEUTRAL',
            confidence: 'LOW',
            reason: 'No clear trend or volume confirmation'
        };
    }
}

// =============== SIGNAL HISTORY MANAGER ===============
class SignalHistoryManager {
    constructor() {
        this.historyFile = path.join(__dirname, 'signal_history.json');
        this.signals = [];
        this.maxSignals = 1000; // Store the last 1000 signals
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.historyFile, 'utf8');
            this.signals = JSON.parse(data);
            console.log(`Loaded ${this.signals.length} historical signals`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist yet, start with empty history
                await this.saveSignals();
                console.log('Created new signal history file');
            } else {
                console.error('Error loading signal history:', error);
            }
        }
    }

    async saveSignals() {
        try {
            //await fs.writeFile(this.historyFile, JSON.stringify(this.signals, null, 2));
        } catch (error) {
            console.error('Error saving signal history:', error);
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
            technical: this.captureMarketData()
        };

        // Add to in-memory array
        this.signals.push(signalRecord);

        // Keep only the most recent signals
        if (this.signals.length > this.maxSignals) {
            this.signals = this.signals.slice(-this.maxSignals);
        }

        // Save to disk
        await this.saveSignals();

        return signalRecord;
    }

    captureMarketData() {
        // This will be implemented in the FuturesTracker class
        // to capture relevant technical data
        return {};
    }

    getRecentSignals(limit = 50) {
        return this.signals.slice(-limit);
    }

    getAllSignals() {
        return this.signals;
    }

    // Filter signals by type (e.g., "BUY", "SELL", etc.)
    getSignalsByType(type, limit = 50) {
        return this.signals
            .filter(signal => signal.signal.includes(type))
            .slice(-limit);
    }

    // Get signals that occurred within a time range
    getSignalsByTimeRange(startTime, endTime) {
        return this.signals.filter(signal => {
            const signalTime = new Date(signal.timestamp).getTime();
            return signalTime >= startTime && signalTime <= endTime;
        });
    }

    // Get signal accuracy statistics
    getSignalStats() {
        // Group signals by type
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

class TradeHistoryManager {
    constructor() {
        this.historyFile = path.join(__dirname, 'trade_history.json');
        this.trades = [];
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.historyFile, 'utf8');
            this.trades = JSON.parse(data);
            console.log(`Loaded ${this.trades.length} historical trades`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist yet, start with empty history
                await this.saveTrades();
            } else {
                console.error('Error loading trade history:', error);
            }
        }
    }

    async saveTrades() {
        try {
            await fs.writeFile(this.historyFile, JSON.stringify(this.trades, null, 2));
        } catch (error) {
            console.error('Error saving trade history:', error);
        }
    }

    async addTrade(trade) {
        const tradeWithTimestamp = {
            ...trade,
            timestamp: trade.timestamp || Date.now(),
            entryTime: new Date(trade.timestamp || Date.now()).toISOString(),
            exitTime: trade.exitTime ? new Date(trade.exitTime).toISOString() : null
        };
        this.trades.push(tradeWithTimestamp);
        await this.saveTrades();
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

        // Calculate total PnL
        const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);

        // Calculate win rate
        const winRate = (winningTrades.length / closedTrades.length) * 100;

        // Calculate average win and loss
        const avgWin = winningTrades.length > 0 ?
            winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ?
            losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;

        // Calculate largest win and loss
        const largestWin = winningTrades.length > 0 ?
            Math.max(...winningTrades.map(t => t.pnl)) : 0;
        const largestLoss = losingTrades.length > 0 ?
            Math.min(...losingTrades.map(t => t.pnl)) : 0;

        // Calculate profit factor
        const totalWins = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

        // Calculate average trade duration
        const tradesWithDuration = closedTrades.filter(t => t.entryTime && t.exitTime);
        const avgTradeDuration = tradesWithDuration.length > 0 ?
            tradesWithDuration.reduce((sum, t) => {
                const duration = new Date(t.exitTime) - new Date(t.entryTime);
                return sum + duration;
            }, 0) / tradesWithDuration.length : 0;

        // Calculate max drawdown (simplified)
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
    constructor(symbol = CONFIG.SYMBOL) {
        this.symbol = symbol;
        this.timeframes = {};
        this.lastSignal = { signal: 'NEUTRAL', confidence: 'LOW', reason: 'Initializing...' };

        // Initialize timeframes
        for (const [interval] of Object.entries(CONFIG.TIMEFRAMES)) {
            this.timeframes[interval] = new MarketData(interval);
        }

        // Initialize components
        this.positionManager = new PositionManager();
        this.tradeExecutor = new TradeExecutor(this.positionManager);
        this.rateLimiter = new RateLimiter(CONFIG.SYSTEM.API_RATE_LIMIT);
        this.currentPrice = null;
        this.tradeExecutor.tracker = this;
        this.signalHistoryManager = new SignalHistoryManager();
        this.tradeHistoryManager = new TradeHistoryManager();
    }

    async start() {
        try {
            console.log('Starting Futures Trading Bot...'.green);
            await this.fetchHistoricalData();
            this.startWebSocket();
            this.startUpdates();
            await this.signalHistoryManager.initialize();
            await this.tradeHistoryManager.initialize();
        } catch (error) {
            console.error('Failed to start tracker:'.red, error);
            process.exit(1);
        }
    }

    async fetchHistoricalData() {
        console.log('Fetching historical data...'.yellow);
        try {
            await Promise.all(
                Object.entries(this.timeframes).map(([interval]) =>
                    this.fetchIntervalData(interval)
                )
            );
            console.log('Historical data loaded successfully'.green);
        } catch (error) {
            throw new TradingError('Historical data fetch failed', 'FETCH_ERROR', true);
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
                `Failed to fetch ${interval} data: ${error.message}`,
                'INTERVAL_FETCH_ERROR',
                true
            );
        }
    }

    startWebSocket() {
        console.log('Initializing WebSocket connection...'.yellow);
        const streams = Object.keys(this.timeframes)
            .map(interval => `${this.symbol}@kline_${interval}`)
            .join('/');

        const ws = new WebSocket(
            `wss://stream.binance.com:9443/stream?streams=${streams}`
        );

        ws.on('open', () => console.log('WebSocket Connected'.green));

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                if (message.data?.k) {
                    this.handleKline(message.data.k);
                }
            } catch (error) {
                console.error('WebSocket message error:'.red, error);
            }
        });

        ws.on('close', () => {
            console.log('WebSocket disconnected, reconnecting...'.yellow);
            setTimeout(() => this.startWebSocket(), CONFIG.SYSTEM.RETRY_DELAY);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:'.red, error);
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
        this.checkForSignals(); // Check signals on every price update

        // Check position status
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

        // Store the last signal
        this.lastSignal = signal;

        // Save signal to history
        if (this.signalHistoryManager) {
            this.signalHistoryManager.addSignal(signal, this.currentPrice, marketState);
        }

        if (signal.confidence !== 'LOW') {
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

    formatPrice(price) {
        return price ? `$${price.toFixed(2)}` : 'N/A';
    }

    formatPercentage(value) {
        return value ? `${value.toFixed(2)}%` : 'N/A';
    }

    printData() {
        console.clear();
        console.log(`${this.symbol} Futures Analysis:`.bold);
        if (this.currentPrice != null) {
            console.log(`Current Price: $${this.currentPrice.toFixed(2)}`.green);
        } else {
            console.log('Current Price: N/A'.yellow);
        }
        console.log('\nTrading Signal:');
        console.log(`Signal: ${this.lastSignal.signal}`);
        console.log(`Confidence: ${this.lastSignal.confidence}`);
        console.log(`Reason: ${this.lastSignal.reason}`);

        // Print timeframe analysis
        Object.entries(this.timeframes).forEach(([interval, data]) => {
            const { prices, volumes } = data.getData();
            const vwma = TechnicalAnalysis.calculateVWMA(prices, volumes, data.period);
            const rsi = TechnicalAnalysis.calculateRSI(prices);
            const volatility = TechnicalAnalysis.calculateVolatility(prices);
            const volumeAnalysis = TechnicalAnalysis.analyzeVolume(volumes);
            const fibLevels = TechnicalAnalysis.calculateFibonacciLevels(prices);
            const fibAnalysis = TechnicalAnalysis.analyzeFibonacciSignals(this.currentPrice, fibLevels);

            console.log(`\n${interval} Analysis:`);
            console.log(`VWMA(${data.period}): $${vwma.toFixed(2)}`);
            console.log(`RSI: ${rsi.toFixed(2)}%`);
            console.log(`Volatility: ${volatility.toFixed(2)}%`);
            console.log(`Volume Ratio: ${volumeAnalysis.ratio.toFixed(2)}`);
            console.log(`Price/VWMA: ${this.currentPrice > vwma ? 'ABOVE ▲' : 'BELOW ▼'}`);
            console.log('Fibonacci Levels:');
            console.log(`Trend: ${fibAnalysis.trend}`);
            console.log(`Nearest Level: ${fibAnalysis.nearestLevel ? `${(fibAnalysis.nearestLevel.ratio * 100).toFixed(1)}% at $${fibAnalysis.nearestLevel.price.toFixed(2)}` : 'N/A'}`);
            console.log(`Support: ${fibAnalysis.support ? `${(fibAnalysis.support.ratio * 100).toFixed(1)}% at $${fibAnalysis.support.price.toFixed(2)}` : 'N/A'}`);
            console.log(`Resistance: ${fibAnalysis.resistance ? `${(fibAnalysis.resistance.ratio * 100).toFixed(1)}% at $${fibAnalysis.resistance.price.toFixed(2)}` : 'N/A'}`);
        });

        // Print position status
        console.log('\nPosition Status:');
        if (this.positionManager.activePosition) {
            const pos = this.positionManager.activePosition;
            const sizeStr = (typeof pos.size === 'number' && !isNaN(pos.size)) ? pos.size.toFixed(2) : 'N/A';
            const entryStr = (typeof pos.entryPrice === 'number' && !isNaN(pos.entryPrice)) ? pos.entryPrice.toFixed(2) : 'N/A';
            const slStr = (typeof pos.stopLoss === 'number' && !isNaN(pos.stopLoss)) ? pos.stopLoss.toFixed(2) : 'N/A';
            const tpStr = (typeof pos.takeProfit === 'number' && !isNaN(pos.takeProfit)) ? pos.takeProfit.toFixed(2) : 'N/A';
            const levStr = (typeof pos.leverage === 'number' && !isNaN(pos.leverage)) ? pos.leverage : 'N/A';
            const dirStr = pos.direction || 'N/A';
            const pnl = this.positionManager.calculatePnL(this.currentPrice);
            const duration = this.calculatePositionDuration();
            console.log(`Type: ${dirStr}`);
            console.log(`Size: $${sizeStr}`);
            console.log(`Entry: $${entryStr}`);
            console.log(`Stop Loss: $${slStr}`);
            console.log(`Take Profit: $${tpStr}`);
            console.log(`Leverage: ${levStr}x`);
            console.log(`Current PnL: ${typeof pnl === 'number' && !isNaN(pnl) ? pnl.toFixed(2) : 'N/A'}%${pnl >= 0 ? '▲' : '▼'}`);
            console.log(`Duration: ${duration}`);
        } else {
            console.log('No active position');
        }

        // Print performance report
        console.log('\nPerformance Report:');
        if (this.tradeHistoryManager && typeof this.tradeHistoryManager.getTradeStatistics === 'function') {
            const stats = this.tradeHistoryManager.getTradeStatistics();
            console.log(`Total Trades: ${stats.totalTrades}`);
            console.log(`Win Rate: ${stats.winRate.toFixed(2)}%`);
            console.log(`Average Win: ${stats.avgWin.toFixed(2)}%`);
            console.log(`Average Loss: ${stats.avgLoss.toFixed(2)}%`);
            console.log(`Total PnL: ${stats.totalPnL.toFixed(2)}%`);

            if (stats.bestTrade) {
                console.log(`Best Trade:`);
                console.log(`PnL: ${stats.bestTrade.pnl.toFixed(2)}%`);
                console.log(`Date: ${new Date(stats.bestTrade.entryTime).toLocaleString()}`);
            }

            if (stats.worstTrade) {
                console.log(`Worst Trade:`);
                console.log(`PnL: ${stats.worstTrade.pnl.toFixed(2)}%`);
                console.log(`Date: ${new Date(stats.worstTrade.entryTime).toLocaleString()}`);
            }
        } else {
            console.log('No closed trades yet');
        }
    }

    startUpdates() {
        setInterval(() => {
            this.checkForSignals();
            this.printData();

            // Send data to dashboard
            if (io) {
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

                const dashboardData = {
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
                    // Enhanced performance statistics
                    performanceStats: this.tradeHistoryManager.getTradeStatistics(),
                    // All open positions with real-time PnL
                    openPositions: this.tradeHistoryManager.getAllTrades()
                        .filter(trade => trade.status === 'OPEN')
                        .map(trade => ({
                            ...trade,
                            currentPnL: this.tradeExecutor.calculateTradePnL(trade, this.currentPrice)
                        }))
                };

                io.emit('marketUpdate', dashboardData);
            }
        }, CONFIG.SYSTEM.UPDATE_INTERVAL);
    }

    calculatePositionDuration() {
        if (!this.positionManager.activePosition || !this.positionManager.activePosition.entryTime) {
            return 'N/A';
        }

        const entryTime = new Date(this.positionManager.activePosition.entryTime);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Dashboard available at http://localhost:${PORT}`);
});




// Start the bot
const tracker = new FuturesTracker();
tracker.start().catch(console.error);
