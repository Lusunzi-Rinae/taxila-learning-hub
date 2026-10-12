import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
import joblib
import json
import os

os.makedirs('models', exist_ok=True)

print("=" * 60)
print("📚 Training Risk Model (4 features, 3 classes)")
print("=" * 60)

# ---- 1. Load ----
print("\n📂 Loading dataset...")
df = pd.read_csv('datasets/student_performance.csv')
print(f"✅ Loaded {df.shape[0]} rows, {df.shape[1]} columns")

# ---- 2. Clean ----
df = df.replace('ABS', np.nan)
for col in df.columns:
    try:
        df[col] = pd.to_numeric(df[col])
    except Exception:
        pass

# ---- 3. Build ternary target ----
if 'GradeClass' not in df.columns:
    raise SystemExit("❌ GradeClass column not found")

def to_risk_label(gc):
    # A, B, C grades = Safe (passing)
    # D grade = Borderline (low pass)
    # F grade = At Risk (failing)
    if gc <= 2.0:
        return 0   # Safe
    elif gc == 3.0:
        return 1   # Borderline
    else:
        return 2   # At Risk

df['risk_label'] = df['GradeClass'].apply(to_risk_label)

# ---- 4. Features ----
FEATURES = ['Absences', 'GPA', 'Age', 'Gender']

for f in FEATURES:
    if f not in df.columns:
        raise SystemExit(f"❌ Feature '{f}' not in dataset")

df = df.dropna(subset=FEATURES + ['risk_label'])

print("\n🎯 Target distribution:")
counts = df['risk_label'].value_counts().sort_index()
labels = {0: 'Safe', 1: 'Borderline', 2: 'At Risk'}
for k in sorted(labels.keys()):
    n = counts.get(k, 0)
    print(f"   {labels[k]:12s}: {n:5d}  ({100*n/len(df):.1f}%)")

X = df[FEATURES].copy()
y = df['risk_label']

# ---- 5. Split ----
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
print(f"\n📊 Train: {X_train.shape[0]}  Test: {X_test.shape[0]}")

# ---- 6. Scale ----
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# ---- 7. Train ----
print("\n🤖 Training RandomForest (balanced classes)...")
model = RandomForestClassifier(
    n_estimators=200,
    max_depth=10,
    min_samples_leaf=5,
    random_state=42,
    class_weight='balanced'
)
model.fit(X_train_scaled, y_train)

# ---- 8. Evaluate ----
y_pred = model.predict(X_test_scaled)
acc = accuracy_score(y_test, y_pred)
print(f"\n📊 Accuracy: {acc:.4f}")
print("\nConfusion matrix:")
print(confusion_matrix(y_test, y_pred))
print("\nClassification report:")
print(classification_report(
    y_test, y_pred,
    target_names=['Safe', 'Borderline', 'At Risk']
))

# ---- 9. Feature importance ----
print("\n📈 Feature importance:")
for feat, imp in sorted(zip(FEATURES, model.feature_importances_), key=lambda x: -x[1]):
    print(f"   {feat}: {imp:.4f}")

# ---- 10. Save ----
joblib.dump(model, 'models/risk_model.pkl')
joblib.dump(scaler, 'models/scaler.pkl')
with open('models/features.json', 'w') as f:
    json.dump(FEATURES, f)
with open('models/labels.json', 'w') as f:
    json.dump({"0": "Safe", "1": "Borderline", "2": "At Risk"}, f)

print("\n✅ Saved:")
print("   models/risk_model.pkl")
print("   models/scaler.pkl")
print("   models/features.json")
print("   models/labels.json")
print("\n" + "=" * 60)