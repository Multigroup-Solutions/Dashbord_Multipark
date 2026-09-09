"""
Comparador de Pagamentos - Multipark v3
Aplicação desktop para comparar ficheiros de caixa, extratos Viva Wallet,
balance history Stripe e condutores validados.

Lógica de comparação:
1. Pagamento Online: hasOnlinePayment + paymentMethod coincidem? Tem paymentIntentId?
   → Cruzar PI com Stripe
2. Multibanco: cruzar data/hora de saída (checkOut) + valor com Viva Wallet
3. Campanhas: campaignPay TRUE → deve ter método válido (Online+ID, MB, Dinheiro)
              campaignPay FALSE → aviso para investigar
4. Agregadores: Parkos/Parclick/Parkvia/etc → marcar + procurar código reserva
5. Pagamentos mistos: campo pricings com múltiplos métodos
6. Última ação: se action ≠ "Fecho de Caixa" → alerta vermelho
7. Condutores vs Caixa: cruzar matrículas, valores e métodos
8. Por Receber: listar reservas com valores pendentes
9. Matrículas em falta: o que está num ficheiro e não está noutro

Autor: Manus AI para Jorge
Data: 2026-06-12
"""

import customtkinter as ctk
from tkinter import filedialog, messagebox, ttk
import tkinter as tk
import pandas as pd
import numpy as np
import re
import os
import json
from datetime import datetime, timedelta

# Configuração do tema
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# Lista de agregadores conhecidos
AGREGADORES = [
    'Parkos', 'Parclick', 'Parkvia', 'Looking4parking', 'parkimeter',
    'onepark', 'Free2move', 'Parkivado', 'Top Parking'
]


class ComparadorApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        
        self.title("Comparador de Pagamentos - Multipark v3")
        self.geometry("1500x900")
        self.minsize(1200, 700)
        
        # Dados carregados
        self.dados_caixa = None
        self.dados_movimentos = None  # Viva Wallet
        self.dados_balance = None  # Stripe
        self.dados_condutores = {}  # Dict com nome -> df
        self.dados_estatisticas_caixa = {}  # Dict com nome -> {'estatisticas': df, 'reservas': df}
        
        # Resultados
        self.resultados = []
        
        self._criar_interface()
    
    def _criar_interface(self):
        """Criar a interface principal"""
        self.tabview = ctk.CTkTabview(self, width=1480, height=860)
        self.tabview.pack(padx=10, pady=10, fill="both", expand=True)
        
        self.tab_carregar = self.tabview.add("📁 Carregar")
        self._criar_tab_carregar()
        
        self.tab_comparar = self.tabview.add("🔍 Comparar")
        self._criar_tab_comparar()
        
        self.tab_resultados = self.tabview.add("📊 Resultados")
        self._criar_tab_resultados()
        
        self.tab_relatorio = self.tabview.add("📋 Relatório")
        self._criar_tab_relatorio()
    
    def _criar_tab_carregar(self):
        """Tab para carregar ficheiros"""
        info_frame = ctk.CTkFrame(self.tab_carregar)
        info_frame.pack(fill="x", padx=10, pady=5)
        ctk.CTkLabel(info_frame, 
                     text="Carrega os ficheiros. Usa 'Auto-Carregar Pasta' para detetar tudo automaticamente.",
                     font=("Segoe UI", 13)).pack(padx=10, pady=8)
        
        btn_frame = ctk.CTkFrame(self.tab_carregar)
        btn_frame.pack(fill="x", padx=10, pady=5)
        
        botoes = [
            ("📦 Caixa Principal\n(caixa-*.xlsx)", self._carregar_caixa),
            ("💳 Movimentos\n(Viva Wallet)", self._carregar_movimentos),
            ("🏦 Balance\n(Stripe .csv)", self._carregar_balance),
            ("🚗 Condutores\n(múltiplos)", self._carregar_condutores),
            ("📈 Fecho Caixa\n(múltiplos)", self._carregar_estatisticas),
        ]
        
        for i, (text, cmd) in enumerate(botoes):
            ctk.CTkButton(btn_frame, text=text, command=cmd, width=180, height=55,
                          font=("Segoe UI", 11)).grid(row=0, column=i, padx=8, pady=10)
        
        ctk.CTkButton(btn_frame, text="🔄 AUTO-CARREGAR\nPASTA", 
                      command=self._auto_carregar, width=200, height=55,
                      fg_color="#28a745", hover_color="#218838",
                      font=("Segoe UI", 12, "bold")).grid(row=0, column=len(botoes), padx=8, pady=10)
        
        # Status
        self.status_frame = ctk.CTkFrame(self.tab_carregar)
        self.status_frame.pack(fill="both", expand=True, padx=10, pady=5)
        
        ctk.CTkLabel(self.status_frame, text="Estado dos Ficheiros:", 
                     font=("Segoe UI", 14, "bold")).pack(anchor="w", padx=10, pady=5)
        
        self.status_text = ctk.CTkTextbox(self.status_frame, height=400, font=("Consolas", 11))
        self.status_text.pack(fill="both", expand=True, padx=10, pady=5)
        self._atualizar_status()
    
    def _criar_tab_comparar(self):
        """Tab para executar comparações"""
        opcoes_frame = ctk.CTkFrame(self.tab_comparar)
        opcoes_frame.pack(fill="x", padx=10, pady=5)
        
        ctk.CTkLabel(opcoes_frame, text="Comparações disponíveis:",
                     font=("Segoe UI", 14, "bold")).pack(anchor="w", padx=10, pady=5)
        
        self.check_vars = {}
        comparacoes = [
            ("cmp_online", "1️⃣  Pagamento Online: hasOnlinePayment + paymentMethod + paymentIntentId → cruzar com Stripe"),
            ("cmp_multibanco", "2️⃣  Multibanco: cruzar checkOut (data/hora) + valor com extrato Viva Wallet"),
            ("cmp_campaign", "3️⃣  Campanhas: campaignPay TRUE deve ter método válido | FALSE → aviso"),
            ("cmp_agregador", "4️⃣  Agregadores: Parkos/Parclick/Parkvia/etc → marcar + procurar código reserva"),
            ("cmp_misto", "5️⃣  Pagamentos Mistos: detetar múltiplos métodos no pricings"),
            ("cmp_action", "6️⃣  Última Ação: se action ≠ 'Fecho de Caixa' → ALERTA"),
            ("cmp_condutores", "7️⃣  Condutores vs Caixa: cruzar matrículas, valores e métodos"),
            ("cmp_por_receber", "8️⃣  Por Receber: listar reservas com valores pendentes"),
            ("cmp_falta", "9️⃣  Matrículas em Falta: o que está num ficheiro e não está noutro"),
        ]
        
        for key, label in comparacoes:
            var = ctk.BooleanVar(value=True)
            self.check_vars[key] = var
            ctk.CTkCheckBox(opcoes_frame, text=label, variable=var,
                           font=("Segoe UI", 12)).pack(anchor="w", padx=20, pady=4)
        
        ctk.CTkButton(opcoes_frame, text="▶️  EXECUTAR COMPARAÇÕES", 
                      command=self._executar_comparacoes,
                      width=350, height=50, font=("Segoe UI", 14, "bold"),
                      fg_color="#dc3545", hover_color="#c82333").pack(pady=15)
        
        self.progress = ctk.CTkProgressBar(self.tab_comparar, width=700)
        self.progress.pack(pady=5)
        self.progress.set(0)
        
        self.progress_label = ctk.CTkLabel(self.tab_comparar, text="Pronto...",
                                           font=("Segoe UI", 11))
        self.progress_label.pack(pady=2)
    
    def _criar_tab_resultados(self):
        """Tab para ver resultados"""
        filtro_frame = ctk.CTkFrame(self.tab_resultados)
        filtro_frame.pack(fill="x", padx=10, pady=5)
        
        ctk.CTkLabel(filtro_frame, text="Filtrar:", font=("Segoe UI", 12)).pack(side="left", padx=10)
        
        self.filtro_tipo = ctk.CTkComboBox(
            filtro_frame, 
            values=["Todos", "🔴 Erros", "🟡 Avisos", "🟢 OK", "🔵 Agregador", "🟣 Misto", "⚪ Em Falta"],
            command=self._filtrar_resultados, width=160
        )
        self.filtro_tipo.pack(side="left", padx=5)
        self.filtro_tipo.set("Todos")
        
        ctk.CTkButton(filtro_frame, text="📥 Exportar Excel", 
                      command=self._exportar_excel, width=150).pack(side="right", padx=10)
        ctk.CTkButton(filtro_frame, text="📥 Exportar CSV", 
                      command=self._exportar_csv, width=150).pack(side="right", padx=5)
        
        # Treeview
        tree_frame = ctk.CTkFrame(self.tab_resultados)
        tree_frame.pack(fill="both", expand=True, padx=10, pady=5)
        
        style = ttk.Style()
        style.configure("Custom.Treeview", font=("Segoe UI", 10), rowheight=25)
        style.configure("Custom.Treeview.Heading", font=("Segoe UI", 10, "bold"))
        
        columns = ("tipo", "comparacao", "matricula", "cliente", "detalhe", "valor_caixa", "valor_extrato", "action")
        self.tree = ttk.Treeview(tree_frame, columns=columns, show="headings", 
                                 style="Custom.Treeview", height=22)
        
        headings = {
            "tipo": ("⚡", 50),
            "comparacao": ("Comparação", 180),
            "matricula": ("Matrícula", 90),
            "cliente": ("Cliente", 140),
            "detalhe": ("Detalhe", 380),
            "valor_caixa": ("Valor Caixa", 90),
            "valor_extrato": ("Valor Extrato", 90),
            "action": ("Última Ação", 130),
        }
        
        for col, (heading, width) in headings.items():
            self.tree.heading(col, text=heading)
            self.tree.column(col, width=width)
        
        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tree_frame.grid_rowconfigure(0, weight=1)
        tree_frame.grid_columnconfigure(0, weight=1)
        
        # Contadores
        self.counter_frame = ctk.CTkFrame(self.tab_resultados)
        self.counter_frame.pack(fill="x", padx=10, pady=5)
        
        self.lbl_total = ctk.CTkLabel(self.counter_frame, text="Total: 0", font=("Segoe UI", 12, "bold"))
        self.lbl_total.pack(side="left", padx=15)
        self.lbl_erros = ctk.CTkLabel(self.counter_frame, text="🔴 Erros: 0", font=("Segoe UI", 12))
        self.lbl_erros.pack(side="left", padx=15)
        self.lbl_avisos = ctk.CTkLabel(self.counter_frame, text="🟡 Avisos: 0", font=("Segoe UI", 12))
        self.lbl_avisos.pack(side="left", padx=15)
        self.lbl_ok = ctk.CTkLabel(self.counter_frame, text="🟢 OK: 0", font=("Segoe UI", 12))
        self.lbl_ok.pack(side="left", padx=15)
        self.lbl_agregador = ctk.CTkLabel(self.counter_frame, text="🔵 Agregador: 0", font=("Segoe UI", 12))
        self.lbl_agregador.pack(side="left", padx=15)
        self.lbl_misto = ctk.CTkLabel(self.counter_frame, text="🟣 Misto: 0", font=("Segoe UI", 12))
        self.lbl_misto.pack(side="left", padx=15)
        self.lbl_falta = ctk.CTkLabel(self.counter_frame, text="⚪ Falta: 0", font=("Segoe UI", 12))
        self.lbl_falta.pack(side="left", padx=15)
    
    def _criar_tab_relatorio(self):
        """Tab para relatório"""
        self.relatorio_text = ctk.CTkTextbox(self.tab_relatorio, font=("Consolas", 11))
        self.relatorio_text.pack(fill="both", expand=True, padx=10, pady=10)
        
        btn_frame = ctk.CTkFrame(self.tab_relatorio)
        btn_frame.pack(fill="x", padx=10, pady=5)
        ctk.CTkButton(btn_frame, text="📥 Guardar Relatório", 
                      command=self._exportar_relatorio, width=200).pack(side="left", padx=10)
    
    # ==================== CARREGAMENTO ====================
    
    def _carregar_caixa(self):
        filepath = filedialog.askopenfilename(
            title="Selecionar ficheiro de Caixa Principal",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")]
        )
        if filepath:
            self._load_caixa(filepath)
    
    def _load_caixa(self, filepath):
        try:
            self.dados_caixa = pd.read_excel(filepath)
            # Garantir que paymentMethod é string
            if 'paymentMethod' in self.dados_caixa.columns:
                self.dados_caixa['paymentMethod'] = self.dados_caixa['paymentMethod'].fillna('').astype(str)
            self._atualizar_status()
            return True
        except Exception as e:
            messagebox.showerror("Erro", f"Erro ao carregar caixa: {e}")
            return False
    
    def _carregar_movimentos(self):
        filepath = filedialog.askopenfilename(
            title="Selecionar Movimentos (Viva Wallet)",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")]
        )
        if filepath:
            self._load_movimentos(filepath)
    
    def _load_movimentos(self, filepath):
        try:
            self.dados_movimentos = pd.read_excel(filepath)
            # Preparar datetime
            self.dados_movimentos['datetime'] = pd.to_datetime(
                self.dados_movimentos['Date'].astype(str) + ' ' + self.dados_movimentos['Time'].astype(str),
                errors='coerce'
            )
            self.dados_movimentos['Amount'] = pd.to_numeric(self.dados_movimentos['Amount'], errors='coerce')
            self._atualizar_status()
            return True
        except Exception as e:
            messagebox.showerror("Erro", f"Erro ao carregar movimentos: {e}")
            return False
    
    def _carregar_balance(self):
        filepath = filedialog.askopenfilename(
            title="Selecionar Balance History (Stripe)",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if filepath:
            self._load_balance(filepath)
    
    def _load_balance(self, filepath):
        try:
            self.dados_balance = self._parse_stripe_csv(filepath)
            self._atualizar_status()
            return True
        except Exception as e:
            messagebox.showerror("Erro", f"Erro ao carregar balance: {e}")
            return False
    
    def _carregar_condutores(self):
        """Carregar múltiplos ficheiros de condutores"""
        filepaths = filedialog.askopenfilenames(
            title="Selecionar ficheiros de Condutores Validados (podes selecionar vários)",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")]
        )
        if filepaths:
            count = 0
            for fp in filepaths:
                if self._load_condutor(fp):
                    count += 1
            self._atualizar_status()
            messagebox.showinfo("OK", f"Carregados {count} ficheiros de condutores.")
    
    def _load_condutor(self, filepath):
        try:
            nome = os.path.basename(filepath)
            reservas = pd.read_excel(filepath, sheet_name='Reservas')
            try:
                stats = pd.read_excel(filepath, sheet_name='Estatísticas')
            except:
                stats = None
            self.dados_condutores[nome] = {'reservas': reservas, 'estatisticas': stats}
            return True
        except Exception as e:
            return False
    
    def _carregar_estatisticas(self):
        """Carregar múltiplos ficheiros de fecho de caixa/estatísticas"""
        filepaths = filedialog.askopenfilenames(
            title="Selecionar ficheiros de Fecho de Caixa (podes selecionar vários)",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")]
        )
        if filepaths:
            count = 0
            for fp in filepaths:
                if self._load_estatisticas(fp):
                    count += 1
            self._atualizar_status()
            messagebox.showinfo("OK", f"Carregados {count} ficheiros de fecho de caixa.")
    
    def _load_estatisticas(self, filepath):
        try:
            nome = os.path.basename(filepath)
            try:
                stats = pd.read_excel(filepath, sheet_name='Estatísticas')
            except:
                stats = None
            try:
                reservas = pd.read_excel(filepath, sheet_name='Reservas')
            except:
                reservas = None
            
            if stats is not None or reservas is not None:
                self.dados_estatisticas_caixa[nome] = {'estatisticas': stats, 'reservas': reservas}
                return True
            return False
        except Exception as e:
            return False
    
    def _auto_carregar(self):
        """Auto-detetar e carregar todos os ficheiros de uma pasta"""
        folder = filedialog.askdirectory(title="Selecionar pasta com ficheiros")
        if not folder:
            return
        
        counts = {'caixa': 0, 'movimentos': 0, 'stripe': 0, 'condutores': 0, 'fecho': 0, 'erros': 0}
        
        for f in os.listdir(folder):
            filepath = os.path.join(folder, f)
            if not os.path.isfile(filepath):
                continue
            try:
                if f.startswith('caixa-') and f.endswith('.xlsx') and 'fechada' not in f:
                    if self._load_caixa(filepath):
                        counts['caixa'] += 1
                elif f.startswith('Movimentos') and f.endswith('.xlsx'):
                    if self._load_movimentos(filepath):
                        counts['movimentos'] += 1
                elif f.endswith('.csv') and ('balance' in f.lower() or 'payment' in f.lower() or 'unified' in f.lower()):
                    if self._load_balance(filepath):
                        counts['stripe'] += 1
                elif f.startswith('condutor-validado') and f.endswith('.xlsx'):
                    if self._load_condutor(filepath):
                        counts['condutores'] += 1
                elif (f.startswith('estatisticas-caixa') or f.startswith('caixa-fechada')) and f.endswith('.xlsx'):
                    if self._load_estatisticas(filepath):
                        counts['fecho'] += 1
            except:
                counts['erros'] += 1
        
        self._atualizar_status()
        msg = f"""Auto-Carregamento concluído!

✅ Caixa Principal: {counts['caixa']}
✅ Movimentos Viva Wallet: {counts['movimentos']}
✅ Stripe: {counts['stripe']}
✅ Condutores: {counts['condutores']}
✅ Fecho de Caixa: {counts['fecho']}

{'⚠️ Erros: ' + str(counts['erros']) if counts['erros'] > 0 else ''}"""
        messagebox.showinfo("Auto-Carregamento", msg)
    
    def _parse_stripe_csv(self, filepath):
        """Parsear CSV do Stripe - suporta ambos os formatos (balance_history e unified_payments)"""
        try:
            # Tentar ler como CSV normal primeiro (unified_payments)
            df = pd.read_csv(filepath, encoding='utf-8')
            
            # Detetar formato pelo nome das colunas
            if 'PaymentIntent ID' in df.columns:
                # Formato unified_payments com PI direto!
                for col in ['Amount', 'Amount Refunded', 'Converted Amount', 'Fee', 'Taxes On Fee']:
                    if col in df.columns:
                        df[col] = df[col].astype(str).str.replace(',', '.').astype(float, errors='ignore')
                        df[col] = pd.to_numeric(df[col], errors='coerce')
                df['_format'] = 'unified_pi'
                df['Type'] = df['Status'].map({'Paid': 'charge', 'Failed': 'failed', 'Refunded': 'refund'})
                return df
            
            elif 'Status' in df.columns and 'Created date (UTC)' in df.columns:
                # Formato unified_payments sem PI
                for col in ['Amount', 'Amount Refunded', 'Converted Amount', 'Fee', 'Taxes On Fee']:
                    if col in df.columns:
                        df[col] = df[col].astype(str).str.replace(',', '.').astype(float, errors='ignore')
                        df[col] = pd.to_numeric(df[col], errors='coerce')
                df['_format'] = 'unified'
                df['Type'] = df['Status'].map({'Paid': 'charge', 'Failed': 'failed', 'Refunded': 'refund'})
                return df
            
            elif 'Type' in df.columns and 'Source' in df.columns:
                # Formato balance_history.csv antigo
                for col in ['Amount', 'Fee', 'Net']:
                    if col in df.columns:
                        df[col] = pd.to_numeric(df[col], errors='coerce')
                df['_format'] = 'balance'
                return df
            
            else:
                pass
        except:
            pass
        
        # Fallback: parser manual para CSVs com formato estranho
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        header = lines[0].strip().split(',')
        data_rows = []
        
        for raw_line in lines[1:]:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith('"') and line.endswith('"'):
                line = line[1:-1]
            line = re.sub(r'""(\d+),(\d+)""', r'\1.\2', line)
            line = re.sub(r'""(-\d+),(\d+)""', r'-\1.\2', line)
            line = line.replace('""', '')
            
            parts = line.split(',')
            if len(parts) >= len(header):
                data_rows.append(parts[:len(header)])
            else:
                parts.extend([''] * (len(header) - len(parts)))
                data_rows.append(parts)
        
        df = pd.DataFrame(data_rows, columns=header)
        for col in ['Amount', 'Fee', 'Net']:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
        df['_format'] = 'manual'
        return df
    
    def _atualizar_status(self):
        """Atualizar texto de status"""
        self.status_text.delete("1.0", "end")
        
        s = "═" * 55 + "\n"
        s += "  FICHEIROS CARREGADOS\n"
        s += "═" * 55 + "\n\n"
        
        if self.dados_caixa is not None:
            s += f"  ✅ CAIXA PRINCIPAL: {len(self.dados_caixa)} registos\n"
            try:
                metodos = self.dados_caixa['paymentMethod'].dropna().unique()[:6]
                s += f"     Métodos: {', '.join(str(m) for m in metodos)}...\n\n"
            except:
                s += "\n"
        else:
            s += "  ❌ CAIXA PRINCIPAL: Não carregada\n\n"
        
        if self.dados_movimentos is not None:
            s += f"  ✅ VIVA WALLET: {len(self.dados_movimentos)} transações\n"
            try:
                card_present = len(self.dados_movimentos[self.dados_movimentos['Channel']=='Card Present (VivaPayments Host)'])
                smart = len(self.dados_movimentos[self.dados_movimentos['Channel']=='Smart Checkout'])
                s += f"     Card Present: {card_present} | Smart Checkout: {smart}\n\n"
            except:
                s += "\n"
        else:
            s += "  ❌ VIVA WALLET: Não carregado\n\n"
        
        if self.dados_balance is not None:
            try:
                charges = self.dados_balance[self.dados_balance['Type'] == 'charge']
                fmt = self.dados_balance.get('_format', pd.Series(['?'])).iloc[0]
                s += f"  ✅ STRIPE: {len(self.dados_balance)} transações ({len(charges)} charges) [formato: {fmt}]\n\n"
            except:
                s += f"  ✅ STRIPE: {len(self.dados_balance)} transações\n\n"
        else:
            s += "  ❌ STRIPE: Não carregado\n\n"
        
        if self.dados_condutores:
            total_reservas = sum(len(d['reservas']) for d in self.dados_condutores.values())
            s += f"  ✅ CONDUTORES: {len(self.dados_condutores)} ficheiros ({total_reservas} reservas)\n"
            for nome in list(self.dados_condutores.keys())[:5]:
                s += f"     → {nome}\n"
            if len(self.dados_condutores) > 5:
                s += f"     ... e mais {len(self.dados_condutores)-5}\n"
            s += "\n"
        else:
            s += "  ❌ CONDUTORES: Nenhum carregado\n\n"
        
        if self.dados_estatisticas_caixa:
            total_reservas = sum(
                len(d['reservas']) for d in self.dados_estatisticas_caixa.values() 
                if d.get('reservas') is not None
            )
            s += f"  ✅ FECHO CAIXA: {len(self.dados_estatisticas_caixa)} ficheiros ({total_reservas} reservas)\n"
            for nome in list(self.dados_estatisticas_caixa.keys())[:5]:
                s += f"     → {nome}\n"
            if len(self.dados_estatisticas_caixa) > 5:
                s += f"     ... e mais {len(self.dados_estatisticas_caixa)-5}\n"
            s += "\n"
        else:
            s += "  ❌ FECHO CAIXA: Nenhum carregado\n\n"
        
        s += "═" * 55 + "\n"
        self.status_text.insert("1.0", s)
    
    # ==================== COMPARAÇÕES ====================
    
    def _executar_comparacoes(self):
        """Executar todas as comparações selecionadas"""
        if self.dados_caixa is None:
            messagebox.showwarning("Aviso", "Carrega pelo menos o ficheiro de Caixa Principal!")
            return
        
        self.resultados = []
        total_checks = sum(1 for v in self.check_vars.values() if v.get())
        if total_checks == 0:
            messagebox.showwarning("Aviso", "Seleciona pelo menos uma comparação!")
            return
        
        step = 0
        checks = [
            ("cmp_online", "Pagamentos Online...", self._cmp_online),
            ("cmp_multibanco", "Multibanco vs Viva Wallet...", self._cmp_multibanco),
            ("cmp_campaign", "Campanhas...", self._cmp_campaign),
            ("cmp_agregador", "Agregadores...", self._cmp_agregador),
            ("cmp_misto", "Pagamentos Mistos...", self._cmp_misto),
            ("cmp_action", "Última Ação...", self._cmp_action),
            ("cmp_condutores", "Condutores vs Caixa...", self._cmp_condutores),
            ("cmp_por_receber", "Por Receber...", self._cmp_por_receber),
            ("cmp_falta", "Matrículas em Falta...", self._cmp_falta),
        ]
        
        try:
            for key, label, func in checks:
                if self.check_vars[key].get():
                    self.progress_label.configure(text=label)
                    self.update()
                    func()
                    step += 1
                    self.progress.set(step / total_checks)
                    self.update()
            
            self.progress.set(1)
            self.progress_label.configure(text=f"✅ Concluído! {len(self.resultados)} resultados.")
            self._mostrar_resultados()
            self._gerar_relatorio()
            self.tabview.set("📊 Resultados")
            
        except Exception as e:
            messagebox.showerror("Erro", f"Erro na comparação: {e}\n\nVerifica os ficheiros carregados.")
            import traceback
            traceback.print_exc()
    
    def _cmp_online(self):
        """
        Comparação 1: Pagamento Online
        - hasOnlinePayment e paymentMethod='Online' devem coincidir
        - Se coincidem → verificar se tem paymentIntentId
        - Se tem PI → cruzar com Stripe
        """
        df = self.dados_caixa
        
        for idx, row in df.iterrows():
            try:
                has_online = row.get('hasOnlinePayment', False)
                metodo = str(row.get('paymentMethod', ''))
                pi_id = row.get('paymentIntentId', None)
                is_online_method = metodo in ['Online', 'Stripe, Online']
                matricula = str(row.get('licensePlate', ''))
                cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                valor = self._parse_valor(row.get('totalPaid', 0))
                action = str(row.get('action', ''))
                
                # Caso 1: hasOnlinePayment=True E método=Online → devem ter PI
                if has_online == True and is_online_method:
                    if pd.notna(pi_id) and str(pi_id).startswith('pi_'):
                        # Tudo OK - verificar no Stripe
                        stripe_ok = self._verificar_stripe(pi_id, valor)
                        
                        if stripe_ok == True:
                            self.resultados.append(self._resultado(
                                '🟢', 'Online OK', matricula, cliente,
                                f"PI confirmado no Stripe: {str(pi_id)[:25]}...",
                                valor, valor, action
                            ))
                        elif stripe_ok == 'valor_diff':
                            self.resultados.append(self._resultado(
                                '🔴', 'Online - VALOR ≠ Stripe', matricula, cliente,
                                f"PI encontrado no Stripe MAS valor diferente! PI={str(pi_id)[:25]}...",
                                valor, '-', action
                            ))
                        elif stripe_ok is None:
                            # Stripe não carregado
                            self.resultados.append(self._resultado(
                                '🟢', 'Online c/ PI', matricula, cliente,
                                f"PI={str(pi_id)[:25]}... (Stripe não carregado p/ confirmar)",
                                valor, '-', action
                            ))
                        else:
                            self.resultados.append(self._resultado(
                                '🟡', 'Online - PI não no Stripe', matricula, cliente,
                                f"PI={str(pi_id)[:25]}... não encontrado no Stripe (pode ser de outro mês)",
                                valor, '-', action
                            ))
                    else:
                        # Tem online mas falta PI
                        self.resultados.append(self._resultado(
                            '🔴', 'Online SEM PI', matricula, cliente,
                            f"hasOnlinePayment=True + Método=Online MAS sem paymentIntentId!",
                            valor, '-', action
                        ))
                
                # Caso 2: hasOnlinePayment=True MAS método NÃO é Online
                elif has_online == True and not is_online_method and metodo not in ['', 'nan']:
                    if pd.notna(pi_id) and str(pi_id).startswith('pi_'):
                        self.resultados.append(self._resultado(
                            '🟢', 'Online+Campanha', matricula, cliente,
                            f"hasOnline=True, Método={metodo}, PI existe",
                            valor, valor, action
                        ))
                    else:
                        self.resultados.append(self._resultado(
                            '🟡', 'Online sem PI', matricula, cliente,
                            f"hasOnline=True, Método={metodo}, MAS sem PI",
                            valor, '-', action
                        ))
                
                # Caso 3: hasOnlinePayment=False MAS método=Online (incoerência)
                elif has_online == False and is_online_method:
                    self.resultados.append(self._resultado(
                        '🔴', 'Incoerência Online', matricula, cliente,
                        f"Método='{metodo}' MAS hasOnlinePayment=False!",
                        valor, '-', action
                    ))
            except Exception:
                continue
    
    def _cmp_multibanco(self):
        """
        Comparação 2: Multibanco vs Viva Wallet
        Cruzar por data de saída (checkOut) + valor com extrato Viva Wallet
        """
        if self.dados_movimentos is None:
            self.resultados.append(self._resultado(
                '🟡', 'MB vs Viva', '-', '-',
                'Ficheiro Viva Wallet não carregado - comparação não possível',
                '', '', ''
            ))
            return
        
        df = self.dados_caixa
        viva = self.dados_movimentos
        
        try:
            viva_card = viva[viva['Channel'] == 'Card Present (VivaPayments Host)'].copy()
        except:
            viva_card = viva.copy()
        
        # Filtrar MB na caixa
        mb_caixa = df[df['paymentMethod'].str.contains('Multibanco', case=False, na=False)].copy()
        
        matched = 0
        not_matched = 0
        
        for idx, row in mb_caixa.iterrows():
            try:
                valor = self._parse_valor(row.get('totalPaid', 0))
                if valor <= 0:
                    continue
                
                checkout_str = str(row.get('checkOut', ''))
                checkout_dt = self._parse_datetime(checkout_str)
                matricula = str(row.get('licensePlate', ''))
                cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                action = str(row.get('action', ''))
                
                if pd.isna(checkout_dt):
                    self.resultados.append(self._resultado(
                        '🟡', 'MB - sem data saída', matricula, cliente,
                        f"Sem data de checkOut para cruzar ({valor}€)",
                        valor, '-', action
                    ))
                    continue
                
                # Procurar no Viva Wallet: mesmo dia + valor
                found = False
                same_day = viva_card[
                    (viva_card['datetime'].dt.date == checkout_dt.date()) &
                    (abs(viva_card['Amount'] - valor) < 0.01)
                ]
                
                if len(same_day) > 0:
                    found = True
                else:
                    # Tentar dia seguinte (pagamento pode ser após checkout)
                    next_day = viva_card[
                        (viva_card['datetime'].dt.date == (checkout_dt + timedelta(days=1)).date()) &
                        (abs(viva_card['Amount'] - valor) < 0.01)
                    ]
                    if len(next_day) > 0:
                        found = True
                
                if found:
                    matched += 1
                else:
                    not_matched += 1
                    self.resultados.append(self._resultado(
                        '🔴', 'MB não no Viva', matricula, cliente,
                        f"MB {valor}€ em {checkout_str} NÃO encontrado no Viva Wallet!",
                        valor, '-', action
                    ))
            except Exception:
                continue
        
        # Resumo
        self.resultados.append(self._resultado(
            '📊', 'MB vs Viva - RESUMO', '-', '-',
            f"✅ Encontrados: {matched} | ❌ Não encontrados: {not_matched} | Total MB: {len(mb_caixa)}",
            '', '', ''
        ))
    
    def _cmp_campaign(self):
        """
        Comparação 3: Campanhas
        - campaignPay=TRUE → deve ter método de pagamento válido
        - campaignPay=FALSE → aviso para investigar
        """
        df = self.dados_caixa
        
        for idx, row in df.iterrows():
            try:
                campaign_pay = row.get('campaignPay', None)
                metodo = str(row.get('paymentMethod', ''))
                pi_id = row.get('paymentIntentId', None)
                matricula = str(row.get('licensePlate', ''))
                cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                valor = self._parse_valor(row.get('totalPaid', 0))
                campaign = str(row.get('campaign', ''))
                action = str(row.get('action', ''))
                
                if campaign_pay == False:
                    self.resultados.append(self._resultado(
                        '🟡', 'Campaign FALSE', matricula, cliente,
                        f"campaignPay=FALSE | campaign='{campaign}' | método='{metodo}' → INVESTIGAR",
                        valor, '-', action
                    ))
                
                elif campaign_pay == True:
                    metodos_validos = ['Online', 'Stripe, Online', 'Multibanco', 'Dinheiro', 'Numerário',
                                       'Transferencia Bancária', 'Transferencia Bancaria', 'Viva Wallet',
                                       '10º Aniversário', 'No pay', 'No Pay']
                    
                    is_agregador = any(ag.lower() in metodo.lower() for ag in AGREGADORES)
                    
                    if metodo in metodos_validos or is_agregador:
                        if metodo in ['Online', 'Stripe, Online']:
                            if not (pd.notna(pi_id) and str(pi_id).startswith('pi_')):
                                self.resultados.append(self._resultado(
                                    '🔴', 'Campaign TRUE sem PI', matricula, cliente,
                                    f"campaignPay=TRUE, Método=Online MAS sem paymentIntentId!",
                                    valor, '-', action
                                ))
                    elif metodo in ['-', '', 'nan']:
                        self.resultados.append(self._resultado(
                            '🔴', 'Campaign TRUE sem método', matricula, cliente,
                            f"campaignPay=TRUE MAS sem método de pagamento! ('{metodo}')",
                            valor, '-', action
                        ))
            except Exception:
                continue
    
    def _cmp_agregador(self):
        """
        Comparação 4: Agregadores
        Parkos/Parclick/Parkvia/etc → marcar como AGREGADOR + procurar código reserva
        """
        df = self.dados_caixa
        
        for idx, row in df.iterrows():
            try:
                metodo = str(row.get('paymentMethod', ''))
                campaign = str(row.get('campaign', ''))
                matricula = str(row.get('licensePlate', ''))
                cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                valor = self._parse_valor(row.get('totalPaid', 0))
                action = str(row.get('action', ''))
                remarks = str(row.get('bookingRemarks', ''))
                remarks2 = str(row.get('remarks', ''))
                credit = str(row.get('credit', ''))
                
                agregador_nome = None
                for ag in AGREGADORES:
                    if ag.lower() in metodo.lower() or ag.lower() in campaign.lower():
                        agregador_nome = ag
                        break
                
                if agregador_nome:
                    codigo_reserva = None
                    all_text = f"{remarks} {remarks2} {credit}"
                    
                    patterns = [
                        r'PSC[\w-]+',
                        r'TX[\w-]+', 
                        r'[Cc]ódigo\s*(?:de\s*)?reserva[:\s]*(\S+)',
                        r'reserva\s*(\d+)',
                        r'\b\d{5,8}\b',
                    ]
                    
                    for pattern in patterns:
                        match = re.search(pattern, all_text)
                        if match:
                            codigo_reserva = match.group(0)
                            break
                    
                    detalhe = f"AGREGADOR: {agregador_nome}"
                    if codigo_reserva:
                        detalhe += f" | Código: {codigo_reserva}"
                    else:
                        detalhe += " | Sem código de reserva"
                    
                    self.resultados.append(self._resultado(
                        '🔵', 'Agregador', matricula, cliente,
                        detalhe, valor, '-', action
                    ))
            except Exception:
                continue
    
    def _cmp_misto(self):
        """
        Comparação 5: Pagamentos Mistos
        Detetar múltiplos métodos no campo pricings
        """
        df = self.dados_caixa
        
        if 'pricings' not in df.columns:
            return
        
        for idx, row in df[df['pricings'].notna()].iterrows():
            try:
                pricings = json.loads(str(row['pricings']))
                metodos = set([item.get('paymentMethod', '') for item in pricings if item.get('paymentMethod', '')])
                
                if len(metodos) > 1:
                    matricula = str(row.get('licensePlate', ''))
                    cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                    valor = self._parse_valor(row.get('totalPaid', 0))
                    action = str(row.get('action', ''))
                    
                    detalhes_metodo = {}
                    for item in pricings:
                        m = item.get('paymentMethod', '?')
                        v = item.get('amountPaid', 0)
                        detalhes_metodo[m] = detalhes_metodo.get(m, 0) + v
                    
                    partes = [f"{m}={v}€" for m, v in detalhes_metodo.items()]
                    
                    self.resultados.append(self._resultado(
                        '🟣', 'Pagamento Misto', matricula, cliente,
                        f"MISTO: {' + '.join(partes)} (Total={valor}€)",
                        valor, '-', action
                    ))
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
    
    def _cmp_action(self):
        """
        Comparação 6: Última Ação
        Se action ≠ "Fecho de Caixa" → ALERTA VERMELHO
        """
        df = self.dados_caixa
        
        for idx, row in df.iterrows():
            try:
                action = str(row.get('action', ''))
                
                if action.lower() not in ['fecho de caixa', 'nan', '']:
                    matricula = str(row.get('licensePlate', ''))
                    cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                    valor = self._parse_valor(row.get('totalPaid', 0))
                    action_user = str(row.get('actionUser', ''))
                    action_date = str(row.get('actionDate', ''))
                    
                    self.resultados.append(self._resultado(
                        '🔴', 'Ação ≠ Fecho', matricula, cliente,
                        f"Última ação: '{action}' por {action_user} em {action_date}",
                        valor, '-', action
                    ))
            except Exception:
                continue
    
    def _cmp_condutores(self):
        """
        Comparação 7: Condutores vs Caixa
        Cruzar matrículas, valores e métodos de pagamento
        """
        if not self.dados_condutores:
            return
        
        df = self.dados_caixa
        
        for nome_ficheiro, dados in self.dados_condutores.items():
            reservas = dados['reservas']
            
            for idx, row in reservas.iterrows():
                try:
                    matricula = str(row.get('Matrícula', '')).strip()
                    if not matricula or matricula == 'nan':
                        continue
                    
                    valor_condutor = self._parse_valor(row.get('Total Pago', 0))
                    metodo_condutor = str(row.get('Método Pagamento', ''))
                    cliente = str(row.get('Cliente', ''))
                    
                    match_caixa = df[df['licensePlate'].astype(str).str.strip().str.upper() == matricula.upper()]
                    
                    if len(match_caixa) == 0:
                        self.resultados.append(self._resultado(
                            '🔴', 'Condutor - não na Caixa', matricula, cliente,
                            f"Matrícula do condutor ({nome_ficheiro}) não encontrada na Caixa!",
                            '-', valor_condutor, ''
                        ))
                    else:
                        for _, caixa_row in match_caixa.iterrows():
                            valor_caixa = self._parse_valor(caixa_row.get('totalPaid', 0))
                            metodo_caixa = str(caixa_row.get('paymentMethod', ''))
                            action = str(caixa_row.get('action', ''))
                            
                            if abs(valor_caixa - valor_condutor) > 0.01 and valor_condutor > 0:
                                self.resultados.append(self._resultado(
                                    '🔴', 'Condutor - valor ≠', matricula, cliente,
                                    f"Condutor={valor_condutor}€ vs Caixa={valor_caixa}€ (diff={abs(valor_caixa-valor_condutor):.2f}€)",
                                    valor_caixa, valor_condutor, action
                                ))
                            
                            if metodo_condutor and metodo_condutor != '-' and metodo_condutor != 'nan':
                                if metodo_condutor.lower() != metodo_caixa.lower():
                                    if ',' not in metodo_caixa:
                                        self.resultados.append(self._resultado(
                                            '🟡', 'Condutor - método ≠', matricula, cliente,
                                            f"Condutor='{metodo_condutor}' vs Caixa='{metodo_caixa}'",
                                            valor_caixa, valor_condutor, action
                                        ))
                except Exception:
                    continue
    
    def _cmp_por_receber(self):
        """
        Comparação 8: Por Receber
        Listar reservas com valores pendentes
        """
        df = self.dados_caixa
        
        if 'totalLeftToPay' not in df.columns:
            return
        
        por_receber = df[pd.to_numeric(df['totalLeftToPay'], errors='coerce') > 0]
        
        for idx, row in por_receber.iterrows():
            try:
                matricula = str(row.get('licensePlate', ''))
                cliente = f"{row.get('name', '')} {row.get('lastname', '')}".strip()
                valor = self._parse_valor(row.get('totalPaid', 0))
                left = self._parse_valor(row.get('totalLeftToPay', 0))
                total = self._parse_valor(row.get('totalGeral', 0))
                action = str(row.get('action', ''))
                
                self.resultados.append(self._resultado(
                    '🟡', 'Por Receber', matricula, cliente,
                    f"Falta: {left}€ | Pago: {valor}€ | Total: {total}€",
                    valor, left, action
                ))
            except Exception:
                continue
    
    def _cmp_falta(self):
        """
        Comparação 9: Matrículas em Falta
        - O que está nos condutores/fecho de caixa mas NÃO está no principal
        - O que está no principal mas NÃO está nos condutores/fecho de caixa
        """
        df = self.dados_caixa
        matriculas_principal = set(df['licensePlate'].astype(str).str.strip().str.upper())
        
        # Matrículas dos condutores
        matriculas_condutores = set()
        for nome_ficheiro, dados in self.dados_condutores.items():
            reservas = dados['reservas']
            for _, row in reservas.iterrows():
                m = str(row.get('Matrícula', '')).strip().upper()
                if m and m != 'NAN':
                    matriculas_condutores.add(m)
        
        # Matrículas do fecho de caixa
        matriculas_fecho = set()
        for nome_ficheiro, dados in self.dados_estatisticas_caixa.items():
            reservas = dados.get('reservas')
            if reservas is not None and 'Matrícula' in reservas.columns:
                for _, row in reservas.iterrows():
                    m = str(row.get('Matrícula', '')).strip().upper()
                    if m and m != 'NAN':
                        matriculas_fecho.add(m)
        
        # Nos condutores mas NÃO no principal
        if matriculas_condutores:
            falta_no_principal_cond = matriculas_condutores - matriculas_principal
            for m in sorted(falta_no_principal_cond):
                self.resultados.append(self._resultado(
                    '⚪', 'No Condutor, não na Caixa', m, '-',
                    f"Matrícula está nos condutores MAS não está na Caixa Principal!",
                    '-', '-', ''
                ))
            
            # No principal mas NÃO nos condutores
            falta_nos_condutores = matriculas_principal - matriculas_condutores
            # Não listar todos (são muitos) - só contar
            if falta_nos_condutores:
                self.resultados.append(self._resultado(
                    '📊', 'Caixa sem Condutor - RESUMO', '-', '-',
                    f"{len(falta_nos_condutores)} matrículas na Caixa Principal sem ficheiro de condutor",
                    '', '', ''
                ))
        
        # No fecho de caixa mas NÃO no principal
        if matriculas_fecho:
            falta_no_principal_fecho = matriculas_fecho - matriculas_principal
            for m in sorted(falta_no_principal_fecho):
                self.resultados.append(self._resultado(
                    '⚪', 'No Fecho, não na Caixa', m, '-',
                    f"Matrícula está no Fecho de Caixa MAS não está na Caixa Principal!",
                    '-', '-', ''
                ))
            
            # No principal mas NÃO no fecho
            falta_no_fecho = matriculas_principal - matriculas_fecho
            if falta_no_fecho:
                self.resultados.append(self._resultado(
                    '📊', 'Caixa sem Fecho - RESUMO', '-', '-',
                    f"{len(falta_no_fecho)} matrículas na Caixa Principal sem registo no Fecho de Caixa",
                    '', '', ''
                ))
    
    # ==================== AUXILIARES ====================
    
    def _verificar_stripe(self, pi_id, valor):
        """Verificar se um pagamento existe no Stripe - cruzamento direto por PaymentIntent ID"""
        if self.dados_balance is None:
            return None
        
        try:
            fmt = self.dados_balance['_format'].iloc[0] if '_format' in self.dados_balance.columns else 'unknown'
            
            # Se temos PaymentIntent ID direto (formato novo) - cruzamento exato!
            if fmt == 'unified_pi' and 'PaymentIntent ID' in self.dados_balance.columns:
                pi_str = str(pi_id)
                match = self.dados_balance[
                    (self.dados_balance['PaymentIntent ID'] == pi_str) &
                    (self.dados_balance['Type'] == 'charge')
                ]
                if len(match) > 0:
                    # Verificar também se o valor bate
                    stripe_valor = match.iloc[0]['Amount']
                    if abs(stripe_valor - valor) < 0.01:
                        return True  # Match perfeito: PI + valor
                    else:
                        return 'valor_diff'  # PI encontrado mas valor diferente
                else:
                    return False  # PI não encontrado no Stripe
            
            # Fallback: cruzamento por valor (formatos antigos)
            charges = self.dados_balance[self.dados_balance['Type'] == 'charge'].copy()
            if len(charges) == 0:
                return None
            
            match = charges[abs(charges['Amount'] - valor) < 0.01]
            if len(match) == 0:
                return False
            else:
                return True
        except:
            return None
    
    def _parse_valor(self, valor):
        """Converter valor para float"""
        if pd.isna(valor):
            return 0.0
        if isinstance(valor, (int, float)):
            return float(valor)
        s = str(valor).replace('€', '').replace(' ', '').replace(',', '.').strip()
        try:
            return float(s)
        except:
            return 0.0
    
    def _parse_datetime(self, val):
        """Parsear datetime no formato dd/mm/yyyy, HH:MM"""
        try:
            return pd.to_datetime(val, format='%d/%m/%Y, %H:%M')
        except:
            try:
                return pd.to_datetime(val, dayfirst=True)
            except:
                return pd.NaT
    
    def _resultado(self, tipo, comparacao, matricula, cliente, detalhe, valor_caixa, valor_extrato, action):
        """Criar dict de resultado"""
        return {
            'tipo': tipo,
            'comparacao': comparacao,
            'matricula': str(matricula),
            'cliente': str(cliente),
            'detalhe': str(detalhe),
            'valor_caixa': str(valor_caixa),
            'valor_extrato': str(valor_extrato),
            'action': str(action),
        }
    
    def _mostrar_resultados(self):
        """Mostrar resultados na treeview"""
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        counts = {'🔴': 0, '🟡': 0, '🟢': 0, '🔵': 0, '🟣': 0, '⚪': 0}
        
        for r in self.resultados:
            tags = ()
            if r['tipo'] == '🔴':
                tags = ('erro',)
                counts['🔴'] += 1
            elif r['tipo'] == '🟡':
                tags = ('aviso',)
                counts['🟡'] += 1
            elif r['tipo'] == '🟢':
                tags = ('ok',)
                counts['🟢'] += 1
            elif r['tipo'] == '🔵':
                tags = ('agregador',)
                counts['🔵'] += 1
            elif r['tipo'] == '🟣':
                tags = ('misto',)
                counts['🟣'] += 1
            elif r['tipo'] == '⚪':
                tags = ('falta',)
                counts['⚪'] += 1
            
            self.tree.insert('', 'end', values=(
                r['tipo'], r['comparacao'], r['matricula'],
                r['cliente'], r['detalhe'], r['valor_caixa'], 
                r['valor_extrato'], r['action']
            ), tags=tags)
        
        self.tree.tag_configure('erro', background='#ffcccc')
        self.tree.tag_configure('aviso', background='#fff3cd')
        self.tree.tag_configure('ok', background='#d4edda')
        self.tree.tag_configure('agregador', background='#cce5ff')
        self.tree.tag_configure('misto', background='#e8daef')
        self.tree.tag_configure('falta', background='#f0f0f0')
        
        self.lbl_total.configure(text=f"Total: {len(self.resultados)}")
        self.lbl_erros.configure(text=f"🔴 Erros: {counts['🔴']}")
        self.lbl_avisos.configure(text=f"🟡 Avisos: {counts['🟡']}")
        self.lbl_ok.configure(text=f"🟢 OK: {counts['🟢']}")
        self.lbl_agregador.configure(text=f"🔵 Agregador: {counts['🔵']}")
        self.lbl_misto.configure(text=f"🟣 Misto: {counts['🟣']}")
        self.lbl_falta.configure(text=f"⚪ Falta: {counts['⚪']}")
    
    def _filtrar_resultados(self, choice):
        """Filtrar resultados"""
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        filtro_map = {
            'Todos': None,
            '🔴 Erros': '🔴',
            '🟡 Avisos': '🟡',
            '🟢 OK': '🟢',
            '🔵 Agregador': '🔵',
            '🟣 Misto': '🟣',
            '⚪ Em Falta': '⚪',
        }
        filtro = filtro_map.get(choice)
        
        for r in self.resultados:
            if filtro and r['tipo'] != filtro:
                continue
            tags = ()
            if r['tipo'] == '🔴': tags = ('erro',)
            elif r['tipo'] == '🟡': tags = ('aviso',)
            elif r['tipo'] == '🟢': tags = ('ok',)
            elif r['tipo'] == '🔵': tags = ('agregador',)
            elif r['tipo'] == '🟣': tags = ('misto',)
            elif r['tipo'] == '⚪': tags = ('falta',)
            
            self.tree.insert('', 'end', values=(
                r['tipo'], r['comparacao'], r['matricula'],
                r['cliente'], r['detalhe'], r['valor_caixa'],
                r['valor_extrato'], r['action']
            ), tags=tags)
    
    def _gerar_relatorio(self):
        """Gerar relatório"""
        self.relatorio_text.delete("1.0", "end")
        
        r = "═" * 65 + "\n"
        r += "  RELATÓRIO DE COMPARAÇÃO DE PAGAMENTOS - MULTIPARK\n"
        r += f"  {datetime.now().strftime('%d/%m/%Y %H:%M')}\n"
        r += "═" * 65 + "\n\n"
        
        counts = {}
        for res in self.resultados:
            counts[res['tipo']] = counts.get(res['tipo'], 0) + 1
        
        r += f"  RESUMO GERAL:\n"
        r += f"  ─────────────\n"
        r += f"  Total verificações: {len(self.resultados)}\n"
        r += f"  🔴 Erros (ação necessária): {counts.get('🔴', 0)}\n"
        r += f"  🟡 Avisos (investigar): {counts.get('🟡', 0)}\n"
        r += f"  🟢 OK: {counts.get('🟢', 0)}\n"
        r += f"  🔵 Agregadores: {counts.get('🔵', 0)}\n"
        r += f"  🟣 Pagamentos Mistos: {counts.get('🟣', 0)}\n"
        r += f"  ⚪ Em Falta: {counts.get('⚪', 0)}\n\n"
        
        # Erros
        erros = [x for x in self.resultados if x['tipo'] == '🔴']
        if erros:
            r += "─" * 65 + "\n"
            r += f"  🔴 ERROS ({len(erros)}):\n"
            r += "─" * 65 + "\n"
            for e in erros:
                r += f"  [{e['matricula']}] {e['comparacao']}\n"
                r += f"    {e['detalhe']}\n"
                if e['action'] and e['action'] != 'nan':
                    r += f"    Última ação: {e['action']}\n"
                r += "\n"
        
        # Em Falta
        falta = [x for x in self.resultados if x['tipo'] == '⚪']
        if falta:
            r += "─" * 65 + "\n"
            r += f"  ⚪ EM FALTA ({len(falta)}):\n"
            r += "─" * 65 + "\n"
            for e in falta:
                r += f"  [{e['matricula']}] {e['detalhe']}\n"
            r += "\n"
        
        # Avisos (primeiros 30)
        avisos = [x for x in self.resultados if x['tipo'] == '🟡']
        if avisos:
            r += "─" * 65 + "\n"
            r += f"  🟡 AVISOS ({len(avisos)}):\n"
            r += "─" * 65 + "\n"
            for e in avisos[:30]:
                r += f"  [{e['matricula']}] {e['detalhe']}\n"
            if len(avisos) > 30:
                r += f"\n  ... e mais {len(avisos)-30} avisos\n"
            r += "\n"
        
        # Agregadores
        agregadores = [x for x in self.resultados if x['tipo'] == '🔵']
        if agregadores:
            r += "─" * 65 + "\n"
            r += f"  🔵 AGREGADORES ({len(agregadores)}):\n"
            r += "─" * 65 + "\n"
            for e in agregadores:
                r += f"  [{e['matricula']}] {e['detalhe']}\n"
            r += "\n"
        
        self.relatorio_text.insert("1.0", r)
    
    def _exportar_csv(self):
        """Exportar para CSV"""
        if not self.resultados:
            messagebox.showwarning("Aviso", "Sem resultados!")
            return
        filepath = filedialog.asksaveasfilename(
            defaultextension=".csv", filetypes=[("CSV", "*.csv")]
        )
        if filepath:
            pd.DataFrame(self.resultados).to_csv(filepath, index=False, encoding='utf-8-sig')
            messagebox.showinfo("OK", f"Exportado: {filepath}")
    
    def _exportar_excel(self):
        """Exportar para Excel com múltiplas sheets"""
        if not self.resultados:
            messagebox.showwarning("Aviso", "Sem resultados!")
            return
        filepath = filedialog.asksaveasfilename(
            defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")]
        )
        if filepath:
            df_all = pd.DataFrame(self.resultados)
            with pd.ExcelWriter(filepath, engine='openpyxl') as writer:
                df_all.to_excel(writer, sheet_name='Todos', index=False)
                
                for tipo, nome in [('🔴','Erros'), ('🟡','Avisos'), ('🔵','Agregadores'), ('🟣','Mistos'), ('⚪','Em Falta')]:
                    subset = df_all[df_all['tipo'] == tipo]
                    if len(subset) > 0:
                        subset.to_excel(writer, sheet_name=nome, index=False)
            
            messagebox.showinfo("OK", f"Exportado: {filepath}")
    
    def _exportar_relatorio(self):
        """Exportar relatório texto"""
        filepath = filedialog.asksaveasfilename(
            defaultextension=".txt", filetypes=[("Text", "*.txt")]
        )
        if filepath:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(self.relatorio_text.get("1.0", "end"))
            messagebox.showinfo("OK", f"Exportado: {filepath}")


if __name__ == "__main__":
    app = ComparadorApp()
    app.mainloop()
