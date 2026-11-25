import json, subprocess, sys
from pathlib import Path
engine=Path(__file__).resolve().parents[1]/"ml_engine.py"
tx=[]
for month in range(1,7):
    tx.append({"id":f"i{month}","title":"Monthly salary","amount":30000,"type":"income","category":"Income","date":f"2026-{month:02d}-01"})
    for day in range(1,9):
        tx.append({"id":f"e{month}-{day}","title":"Swiggy dinner","amount":100+day*4,"type":"expense","category":"Food","date":f"2026-{month:02d}-{day+1:02d}"})
proc=subprocess.run([sys.executable,str(engine)],input=json.dumps({"transactions":tx,"budgets":[],"goals":[]}),text=True,capture_output=True,check=True)
result=json.loads(proc.stdout)
assert result["model_status"]=="hybrid_models_trained"
assert result["metrics"]["categorisation_accuracy"]>=0
assert result["metrics"]["forecast_model_mae_inr"]>=0
assert result["metrics"]["forecast_baseline_mae_inr"]>=0
assert result["forecast"], "Expected personal forecast with six months of records"
assert result["category_predictions"], "Expected transaction title predictions"
assert result["data_summary"]["user_expense_transactions"]==48
assert "spending_profile" in result
print("FinTrack ML smoke test passed")
print(json.dumps({"metrics":result["metrics"],"forecast_categories":len(result["forecast"]),"category_predictions":len(result["category_predictions"]),"anomalies_flagged":len(result["anomalies"]),"profile":result["spending_profile"]},indent=2))
