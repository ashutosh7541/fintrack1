"""FinTrack hybrid ML service: text categorisation, forecasting and anomaly screening."""
import json, sys, math, random, re
from collections import defaultdict
import numpy as np
from sklearn.ensemble import RandomForestRegressor, IsolationForest
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, accuracy_score, f1_score, silhouette_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

SEED=42
random.seed(SEED); np.random.seed(SEED)
CATEGORIES=["Food","Transport","Shopping","Bills","Education","Health","Entertainment","Other"]
WORDS={
"Food":["swiggy dinner","zomato lunch","restaurant meal","grocery vegetables","coffee cafe","pizza order","food delivery","supermarket food"],
"Transport":["uber ride","ola cab","metro card","bus ticket","petrol fuel","auto fare","train ticket","parking charge"],
"Shopping":["amazon order","clothing purchase","shoes store","electronics shop","online shopping","mall purchase","gift purchase"],
"Bills":["electricity bill","mobile recharge","internet broadband","water bill","rent payment","gas cylinder","utility payment"],
"Education":["course fee","university tuition","textbook purchase","online course","exam fee","stationery books"],
"Health":["pharmacy medicine","doctor consultation","hospital visit","medical test","health checkup","clinic fee"],
"Entertainment":["movie ticket","netflix subscription","concert ticket","game purchase","music subscription","weekend event"],
"Other":["miscellaneous payment","cash withdrawal","service charge","personal expense","other payment","unknown merchant"]}

def synthetic_texts():
    # Vary merchants and context so train/test examples are not exact duplicates.
    merchants=["local shop","quick commerce","online store","city outlet","merchant app","campus store","service provider","market"]
    modifiers=["monthly payment","one time purchase","weekend order","nearby transaction","digital payment","personal use","subscription charge","in store purchase"]
    texts=[]; labels=[]
    for cat, samples in WORDS.items():
        for _ in range(220):
            text=f"{random.choice(samples)} {random.choice(merchants)} {random.choice(modifiers)}"
            if random.random()<.25: text += " " + random.choice(["upi","card payment","online","cash","receipt"])
            texts.append(text); labels.append(cat)
    return texts,labels

def train_category_model(transactions):
    texts,labels=synthetic_texts()
    Xtr,Xte,ytr,yte=train_test_split(texts,labels,test_size=.2,random_state=SEED,stratify=labels)
    model=Pipeline([("tfidf",TfidfVectorizer(ngram_range=(1,2),sublinear_tf=True)),("classifier",LogisticRegression(max_iter=1000,class_weight="balanced",random_state=SEED))])
    model.fit(Xtr,ytr); pred=model.predict(Xte)
    metrics={"accuracy":round(float(accuracy_score(yte,pred)),3),"macro_f1":round(float(f1_score(yte,pred,average="macro")),3),"evaluation":"held-out synthetic transaction descriptions"}
    # Add explicitly labelled transactions from this account to personal model fit.
    personal=[t for t in transactions if t.get("type")=="expense" and str(t.get("title","")).strip() and t.get("category") in CATEGORIES]
    if len(personal)>=3:
        model.fit(texts+[str(t["title"]) for t in personal],labels+[t["category"] for t in personal])
    predictions=[]
    for t in transactions:
        if t.get("type")!="expense" or not str(t.get("title","")).strip(): continue
        probs=model.predict_proba([str(t["title"])])[0]; ix=int(np.argmax(probs))
        predictions.append({"id":t.get("id"),"title":t.get("title"),"actual_category":t.get("category","Other"),"predicted_category":str(model.classes_[ix]),"confidence":round(float(probs[ix]),3),"matches":str(model.classes_[ix])==str(t.get("category","Other"))})
    return model,metrics,predictions

def make_synthetic(n_users=120,months=9):
    rows=[]
    profiles=[[.28,.10,.12,.20,.08,.05,.10,.07],[.18,.08,.24,.16,.08,.06,.14,.06],[.22,.18,.08,.25,.10,.07,.04,.06],[.16,.08,.10,.18,.25,.08,.08,.07]]
    for u in range(n_users):
        income=random.uniform(18000,120000); profile=profiles[u%4]
        personal_scale=random.uniform(.8,1.2)
        for m in range(months):
            for ci,cat in enumerate(CATEGORIES):
                base=income*random.uniform(.48,.78)*profile[ci]*personal_scale
                amount=max(0,float(np.random.normal(base,max(50,base*.15))))
                rows.append({"user":u,"month":m,"category":cat,"amount":amount,"income":income})
    return rows

def build_forecast_rows(rows):
    by=defaultdict(float); incomes={}
    for r in rows:
        by[(r['user'],r['month'],r['category'])]+=float(r['amount']); incomes[(r['user'],r['month'])]=float(r['income'])
    X=[]; y=[]; base=[]; users=[]
    for user in sorted({r['user'] for r in rows}):
        for month in range(2,9):
            for ci,cat in enumerate(CATEGORIES):
                a=by[(user,month-1,cat)]; b=by[(user,month-2,cat)]; c=by[(user,month-3,cat)]
                X.append([a,b,c,incomes[(user,month-1)],ci,month])
                y.append(by[(user,month,cat)])
                base.append((a+b+c)/3); users.append(user)
    return np.asarray(X),np.asarray(y),np.asarray(base),np.asarray(users)

def aggregate_months(tx):
    monthly=defaultdict(lambda:defaultdict(float)); incomes=defaultdict(float)
    for t in tx:
        d=str(t.get('date',''))
        if len(d)>=7 and t.get('type') in ('income','expense'):
            if t['type']=='expense': monthly[d[:7]][str(t.get('category','Other'))]+=float(t.get('amount',0))
            else: incomes[d[:7]]+=float(t.get('amount',0))
    return monthly,incomes

def analyse(payload):
    tx=payload.get('transactions',[]); expenses=[t for t in tx if t.get('type')=='expense' and float(t.get('amount',0) or 0)>0]
    category_model,cat_metrics,category_predictions=train_category_model(tx)
    synthetic=make_synthetic(); X,y,baseline,users=build_forecast_rows(synthetic)
    # Hold out entire synthetic users to reduce leakage across a person's monthly history.
    train=users<96; test=~train
    reg=RandomForestRegressor(n_estimators=180,max_depth=11,min_samples_leaf=3,random_state=SEED,n_jobs=1)
    reg.fit(X[train],y[train]); p=reg.predict(X[test])
    forecast_metrics={"model_mae_inr":round(float(mean_absolute_error(y[test],p)),2),"baseline_mae_inr":round(float(mean_absolute_error(y[test],baseline[test])),2),"model_rmse_inr":round(float(mean_squared_error(y[test],p)**.5),2),"baseline":"three-month category average","evaluation":"held-out synthetic users; not personal validation"}
    # Add this account's own labelled monthly history to the final fit.
    # Keep synthetic held-out-user metrics separate from these personal examples.
    personal_monthly, personal_income = aggregate_months(tx)
    personal_months = sorted(personal_monthly)
    personal_X=[]; personal_y=[]
    for idx in range(3, len(personal_months)):
        m0,m1,m2,target_month = personal_months[idx-3:idx+1]
        for ci,cat in enumerate(CATEGORIES):
            personal_X.append([personal_monthly[m2].get(cat,0), personal_monthly[m1].get(cat,0), personal_monthly[m0].get(cat,0), personal_income.get(m2,0), ci, idx])
            personal_y.append(personal_monthly[target_month].get(cat,0))
    if personal_X:
        X_fit=np.vstack([X,np.asarray(personal_X,dtype=float)])
        y_fit=np.concatenate([y,np.asarray(personal_y,dtype=float)])
    else:
        X_fit,y_fit=X,y
    reg.fit(X_fit,y_fit)
    # Anomaly detection: amount relative to category-specific personal median.
    cat_medians={c:float(np.median([float(t['amount']) for t in expenses if t.get('category')==c])) if any(t.get('category')==c for t in expenses) else 1.0 for c in CATEGORIES}
    synth_features=[]
    for r in synthetic:
        c=r['category']; synth_features.append([math.log1p(r['amount']),CATEGORIES.index(c),r['amount']/max(cat_medians[c],1)])
    iso=IsolationForest(n_estimators=180,contamination=.035,random_state=SEED).fit(np.asarray(synth_features))
    anomalies=[]
    for t in sorted(expenses,key=lambda x:str(x.get('date','')),reverse=True)[:300]:
        cat=t.get('category') if t.get('category') in CATEGORIES else 'Other'; amount=float(t['amount'])
        same=[float(x['amount']) for x in expenses if x.get('category')==cat]
        med=float(np.median(same)) if same else 1.0; ratio=amount/max(med,1)
        score=float(iso.decision_function([[math.log1p(amount),CATEGORIES.index(cat),ratio]])[0])
        if int(iso.predict([[math.log1p(amount),CATEGORIES.index(cat),ratio]])[0])==-1 and ratio>=2:
            anomalies.append({"id":t.get('id'),"title":t.get('title','Expense'),"category":cat,"amount":amount,"date":t.get('date',''),"anomaly_score":round(score,4),"reason":"Unusual relative to this category's recorded amounts. Verify manually; this is not a fraud decision."})
        if len(anomalies)>=8: break
    # KMeans profile on synthetic user category shares.
    sums=defaultdict(lambda:defaultdict(float))
    for r in synthetic: sums[r['user']][r['category']]+=r['amount']
    shares=np.array([[sums[u][c] for c in CATEGORIES] for u in range(120)],dtype=float); shares=shares/np.maximum(shares.sum(axis=1,keepdims=True),1)
    scaler=StandardScaler(); Z=scaler.fit_transform(shares); km=KMeans(n_clusters=4,random_state=SEED,n_init=10).fit(Z)
    sil=float(silhouette_score(Z,km.labels_))
    monthly,incomes=aggregate_months(tx); months=sorted(monthly)
    totals=np.array([sum(monthly[m].get(c,0) for m in months) for c in CATEGORIES]); profile='Not enough personal expense data to classify your spending pattern.'
    if totals.sum()>0:
        cluster=int(km.predict(scaler.transform([totals/totals.sum()]))[0]); dominant=CATEGORIES[int(np.argmax(scaler.inverse_transform([km.cluster_centers_[cluster]])[0]))]
        profile=f'Cluster {cluster+1}: {dominant.lower()}-weighted spending pattern'
    forecast=[]; forecast_note=None
    if len(months)>=3:
        last=months[-1]; previous=months[-2]; older=months[-3]
        for ci,cat in enumerate(CATEGORIES):
            a=monthly[last].get(cat,0); b=monthly[previous].get(cat,0); c=monthly[older].get(cat,0)
            features=[[a,b,c,incomes.get(last,0),ci,len(months)]]
            value=max(0,float(reg.predict(features)[0])); avg=(a+b+c)/3
            if value>1 or avg>1: forecast.append({"category":cat,"predicted_amount":round(value,2),"baseline_amount":round(avg,2)})
    else: forecast_note='Add at least three distinct months of transactions for a personal forecast and comparison with the three-month-average baseline.'
    recommendations=[]
    if len(months)>=2:
        for cat in CATEGORIES:
            vals=[monthly[m].get(cat,0) for m in months[-3:]]; avg=float(np.mean(vals))
            if avg>0: recommendations.append({"category":cat,"suggested_limit":round(avg*1.05/10)*10,"recent_average":round(avg,2),"basis":"three-month personal average + 5% rule"})
    return {"model_status":"hybrid_models_trained","metrics":{"categorisation_accuracy":cat_metrics['accuracy'],"categorisation_macro_f1":cat_metrics['macro_f1'],"categorisation_evaluation":cat_metrics['evaluation'],"forecast_model_mae_inr":forecast_metrics['model_mae_inr'],"forecast_baseline_mae_inr":forecast_metrics['baseline_mae_inr'],"forecast_model_rmse_inr":forecast_metrics['model_rmse_inr'],"forecast_evaluation":forecast_metrics['evaluation'],"cluster_silhouette":round(sil,3)},"forecast_metrics":forecast_metrics,"category_predictions":category_predictions[:40],"forecast":forecast,"forecast_note":forecast_note,"anomalies":anomalies,"spending_profile":profile,"budget_recommendations":recommendations,"data_summary":{"user_expense_transactions":len(expenses),"months_with_expenses":len(months),"synthetic_training_records":len(synthetic),"personal_labelled_category_examples":sum(1 for t in expenses if t.get('category') in CATEGORIES)}}

if __name__=='__main__':
    try: print(json.dumps(analyse(json.load(sys.stdin))))
    except Exception as exc: print(json.dumps({"error":str(exc)})); sys.exit(1)
