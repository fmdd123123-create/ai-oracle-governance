"""
AI-Adaptive PMM: 四节点模拟实验
MVP Phase 1 - 本地 Python 模拟

验证：4 个 AI agent 协调调参，对比有/无 AI 调参的 LP 表现
"""

import math
import random
from dataclasses import dataclass
from typing import Optional


# ============ PMM 核心定价（从 DODO PMMPricing.sol 翻译） ============

@dataclass
class PMMState:
    """PMM 状态"""
    i: float      # oracle 价格 (quote per base)
    K: float      # 曲线弯曲度 (0=恒定价格, 1=Uniswap x*y=k)
    B: float      # 当前 base 余额
    Q: float      # 当前 quote 余额
    B0: float     # 目标 base 余额
    Q0: float     # 目标 quote 余额


def pmm_sell_base(state: PMMState, amount: float) -> float:
    """卖出 base token，返回获得的 quote 数量"""
    # 简化版 PMM 定价公式
    # P = i * (1 - K + K * (B0/B)^2)
    B_new = state.B + amount
    # 积分计算
    avg_price = state.i * (1 - state.K + state.K * (state.B0 ** 2) / (state.B * B_new))
    return amount * avg_price


def pmm_sell_quote(state: PMMState, amount: float) -> float:
    """卖出 quote token，返回获得的 base 数量"""
    Q_new = state.Q + amount
    avg_price = state.i * (1 - state.K + state.K * (state.Q0 ** 2) / (state.Q * Q_new))
    return amount / avg_price


# ============ 四个 AI Agent ============

@dataclass
class Proposal:
    new_i: Optional[float] = None
    new_K: Optional[float] = None
    new_fee: Optional[float] = None
    reason: str = ""


class PriceOracle:
    """Agent 1: 价格预言机"""
    
    def __init__(self):
        self.price_history = []
    
    def observe(self, cex_price: float, current_i: float) -> Proposal:
        self.price_history.append(cex_price)
        # 简单策略：跟踪 CEX 价格，EMA 平滑
        if len(self.price_history) < 3:
            return Proposal(new_i=cex_price, reason="初始跟踪")
        
        ema = self.price_history[-1] * 0.5 + self.price_history[-2] * 0.3 + self.price_history[-3] * 0.2
        deviation = abs(ema - current_i) / current_i
        
        if deviation > 0.002:  # 偏差 > 0.2% 才调
            return Proposal(new_i=ema, reason=f"价格偏离 {deviation:.4f}")
        return Proposal(new_i=None, reason="价格在范围内")


class VolatilitySensor:
    """Agent 2: 波动率感知器"""
    
    def __init__(self):
        self.returns = []
    
    def observe(self, cex_price: float, current_K: float) -> Proposal:
        if len(self.returns) > 0:
            ret = (cex_price - self.returns[-1]) / self.returns[-1]
        else:
            ret = 0
        self.returns.append(cex_price)
        
        if len(self.returns) < 5:
            return Proposal(new_K=current_K, reason="数据不足")
        
        # 计算近 5 期波动率
        recent = self.returns[-5:]
        vol = sum(abs(recent[i] - recent[i-1]) / recent[i-1] for i in range(1, 5)) / 4
        
        # 波动大 → K 调高（保护 LP，曲线更像 Uniswap）
        # 波动小 → K 调低（减少滑点，曲线更平）
        if vol > 0.02:  # 高波动
            target_K = min(current_K + 0.1, 0.8)
            return Proposal(new_K=target_K, reason=f"高波动 vol={vol:.4f}, K↑")
        elif vol < 0.005:  # 低波动
            target_K = max(current_K - 0.05, 0.05)
            return Proposal(new_K=target_K, reason=f"低波动 vol={vol:.4f}, K↓")
        return Proposal(new_K=None, reason=f"波动适中 vol={vol:.4f}")


class FeeOptimizer:
    """Agent 3: 费率优化器"""
    
    def __init__(self):
        self.arb_count = 0
        self.total_trades = 0
    
    def observe(self, is_arb: bool, current_fee: float) -> Proposal:
        self.total_trades += 1
        if is_arb:
            self.arb_count += 1
        
        if self.total_trades < 10:
            return Proposal(new_fee=current_fee, reason="数据不足")
        
        arb_ratio = self.arb_count / self.total_trades
        
        # 套利占比高 → 费率升高（抵御 MEV）
        if arb_ratio > 0.3:
            target_fee = min(current_fee + 0.001, 0.01)  # 最高 1%
            return Proposal(new_fee=target_fee, reason=f"套利率 {arb_ratio:.2f}, fee↑")
        elif arb_ratio < 0.1:
            target_fee = max(current_fee - 0.0005, 0.0005)  # 最低 0.05%
            return Proposal(new_fee=target_fee, reason=f"套利率 {arb_ratio:.2f}, fee↓")
        return Proposal(new_fee=None, reason=f"套利率正常 {arb_ratio:.2f}")


class ConsensusArbiter:
    """Agent 4: 共识仲裁者"""
    
    def decide(self, proposals: list[Proposal], current_state: PMMState, current_fee: float):
        """收集 3 个 agent 提议，多数一致才执行"""
        actions = {}
        
        # 价格共识
        price_proposal = proposals[0]  # Agent 1 唯一负责价格
        if price_proposal.new_i is not None:
            actions['i'] = price_proposal.new_i
        
        # K 值共识
        k_proposal = proposals[1]  # Agent 2 唯一负责 K
        if k_proposal.new_K is not None:
            actions['K'] = k_proposal.new_K
        
        # 费率共识
        fee_proposal = proposals[2]  # Agent 3 唯一负责费率
        if fee_proposal.new_fee is not None:
            actions['fee'] = fee_proposal.new_fee
        
        return actions


# ============ 模拟引擎 ============

class Simulation:
    """模拟 1000 笔交易 + 外部价格变动"""
    
    def __init__(self, initial_price=2000.0, initial_base=10.0, initial_quote=20000.0):
        # 池子初始状态
        self.state = PMMState(
            i=initial_price,
            K=0.3,          # 初始弯曲度
            B=initial_base,
            Q=initial_quote,
            B0=initial_base,
            Q0=initial_quote
        )
        self.fee_rate = 0.003  # 0.3%
        
        # AI Agents
        self.price_oracle = PriceOracle()
        self.vol_sensor = VolatilitySensor()
        self.fee_optimizer = FeeOptimizer()
        self.arbiter = ConsensusArbiter()
        
        # 外部市场价格（模拟 CEX）
        self.cex_price = initial_price
        
        # 统计
        self.lp_value_history = []
        self.adjustments = 0
        self.arb_profits = 0.0
    
    def step_market(self):
        """模拟外部市场价格变动"""
        # 随机游走 + 偶尔跳变
        if random.random() < 0.05:  # 5% 概率大幅跳变
            self.cex_price *= (1 + random.uniform(-0.05, 0.05))
        else:
            self.cex_price *= (1 + random.gauss(0, 0.003))
    
    def detect_arb(self) -> bool:
        """检测当前是否存在套利机会"""
        pool_price = self.state.i * (1 - self.state.K + self.state.K * (self.state.B0 / self.state.B) ** 2)
        return abs(pool_price - self.cex_price) / self.cex_price > 0.005
    
    def execute_trade(self, is_arb: bool):
        """模拟一笔交易"""
        if is_arb:
            # 套利交易：池子价格偏离 CEX，套利者搬平
            pool_price = self.state.i * (1 - self.state.K + self.state.K * (self.state.B0 / self.state.B) ** 2)
            if pool_price > self.cex_price:
                # 池子价格高，卖 base 给池子
                amount = self.state.B * 0.02  # 交易量 = 池子 2%
                received = pmm_sell_base(self.state, amount) * (1 - self.fee_rate)
                self.state.B += amount
                self.state.Q -= received
                arb_profit = received - amount * self.cex_price
                self.arb_profits += max(0, arb_profit)
            else:
                # 池子价格低，买 base
                amount = self.state.Q * 0.02
                received = pmm_sell_quote(self.state, amount) * (1 - self.fee_rate)
                self.state.Q += amount
                self.state.B -= received
                arb_profit = received * self.cex_price - amount
                self.arb_profits += max(0, arb_profit)
        else:
            # 普通交易：随机方向
            if random.random() < 0.5:
                amount = self.state.B * random.uniform(0.001, 0.01)
                received = pmm_sell_base(self.state, amount) * (1 - self.fee_rate)
                self.state.B += amount
                self.state.Q -= received
            else:
                amount = self.state.Q * random.uniform(0.001, 0.01)
                received = pmm_sell_quote(self.state, amount) * (1 - self.fee_rate)
                self.state.Q += amount
                self.state.B -= received
    
    def ai_adjust(self):
        """AI Agent 调参"""
        is_arb = self.detect_arb()
        
        p1 = self.price_oracle.observe(self.cex_price, self.state.i)
        p2 = self.vol_sensor.observe(self.cex_price, self.state.K)
        p3 = self.fee_optimizer.observe(is_arb, self.fee_rate)
        
        actions = self.arbiter.decide([p1, p2, p3], self.state, self.fee_rate)
        
        if actions:
            if 'i' in actions:
                self.state.i = actions['i']
            if 'K' in actions:
                self.state.K = actions['K']
            if 'fee' in actions:
                self.fee_rate = actions['fee']
            self.adjustments += 1
    
    def lp_value(self) -> float:
        """当前 LP 持有的总价值（以 quote 计）"""
        return self.state.B * self.cex_price + self.state.Q
    
    def run(self, num_trades=1000, with_ai=True):
        """运行模拟"""
        initial_value = self.lp_value()
        self.lp_value_history = [initial_value]
        
        for t in range(num_trades):
            # 1. 外部市场变动
            self.step_market()
            
            # 2. AI 调参（如果启用）
            if with_ai and t % 5 == 0:  # 每 5 笔交易调一次
                self.ai_adjust()
            
            # 3. 检测套利机会
            is_arb = self.detect_arb()
            
            # 4. 执行交易
            self.execute_trade(is_arb)
            
            # 5. 记录 LP 价值
            self.lp_value_history.append(self.lp_value())
        
        final_value = self.lp_value()
        hold_value = (self.state.B0 * self.cex_price + self.state.Q0)  # 如果不做 LP 纯持有
        
        return {
            'initial_value': initial_value,
            'final_value': final_value,
            'hold_value': hold_value,
            'impermanent_loss': (final_value - hold_value) / hold_value,
            'arb_profits_leaked': self.arb_profits,
            'adjustments_made': self.adjustments,
            'final_price': self.cex_price,
            'final_K': self.state.K,
            'final_fee': self.fee_rate,
        }


# ============ 运行对比实验 ============

if __name__ == '__main__':
    random.seed(42)
    
    print("=" * 60)
    print("AI-Adaptive PMM 四节点实验")
    print("=" * 60)
    
    # 实验 1: 有 AI 调参
    print("\n[实验 A] PMM + AI Agent 调参")
    sim_ai = Simulation()
    result_ai = sim_ai.run(num_trades=1000, with_ai=True)
    
    print(f"  初始 LP 价值:    ${result_ai['initial_value']:.2f}")
    print(f"  最终 LP 价值:    ${result_ai['final_value']:.2f}")
    print(f"  纯持有价值:      ${result_ai['hold_value']:.2f}")
    print(f"  无常损失:        {result_ai['impermanent_loss']*100:.3f}%")
    print(f"  被套利金额:      ${result_ai['arb_profits_leaked']:.2f}")
    print(f"  AI 调参次数:     {result_ai['adjustments_made']}")
    print(f"  最终 K 值:       {result_ai['final_K']:.3f}")
    print(f"  最终费率:        {result_ai['final_fee']*100:.3f}%")
    
    # 实验 2: 无 AI，固定参数
    random.seed(42)  # 相同随机种子
    print("\n[实验 B] PMM 固定参数（无 AI）")
    sim_fixed = Simulation()
    result_fixed = sim_fixed.run(num_trades=1000, with_ai=False)
    
    print(f"  初始 LP 价值:    ${result_fixed['initial_value']:.2f}")
    print(f"  最终 LP 价值:    ${result_fixed['final_value']:.2f}")
    print(f"  纯持有价值:      ${result_fixed['hold_value']:.2f}")
    print(f"  无常损失:        {result_fixed['impermanent_loss']*100:.3f}%")
    print(f"  被套利金额:      ${result_fixed['arb_profits_leaked']:.2f}")
    
    # 对比
    print("\n" + "=" * 60)
    print("[对比结果]")
    improvement = (result_ai['final_value'] - result_fixed['final_value']) / result_fixed['final_value']
    arb_reduction = 1 - result_ai['arb_profits_leaked'] / max(result_fixed['arb_profits_leaked'], 0.01)
    print(f"  LP 收益改善:     {improvement*100:+.3f}%")
    print(f"  套利泄漏减少:    {arb_reduction*100:.1f}%")
    print(f"  结论: {'AI 调参有效 ✅' if improvement > 0 else 'AI 调参无效 ❌'}")
