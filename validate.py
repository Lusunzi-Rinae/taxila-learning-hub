import pandas as pd
import numpy as np
from sklearn.model_selection import cross_val_score, cross_val_predict, StratifiedKFold
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.pipeline import Pipeline

print("=" * 60)
print("📊 Model Validation — K-Fold Cross-Validation")
print("=" * 60)

# ---- 1. Load data (same prep as train.py) ----
print("\n📂 Loading dataset...")
df = pd.read_csv('datasets/student_performance.csv')
print(f"✅ {df.shape[0]} rows loaded")

df = df.replace('ABS', np.nan)
for col in df.columns:
    try:
        df[col] = pd.to_numeric(df[col])
    except Exception:
        pass

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

FEATURES = ['Absences', 'GPA', 'Age', 'Gender']
df = df.dropna(subset=FEATURES + ['risk_label'])

X = df[FEATURES].values
y = df['risk_label'].values

print(f"\n📊 Usable samples: {len(y)}")
print("📊 Class distribution:")
for label_id, name in {0: 'Safe', 1: 'Borderline', 2: 'At Risk'}.items():
    n = int((y == label_id).sum())
    print(f"   {name:12s}: {n:5d}  ({100*n/len(y):.1f}%)")

# ---- 3. Build pipeline (scaler + model together) ----
# Using a Pipeline is the key detail:
# it ensures the scaler is fit ONLY on training data in each fold.
pipeline = Pipeline([
    ('scaler', StandardScaler()),
    ('model', RandomForestClassifier(
        n_estimators=200,
        max_depth=10,
        min_samples_leaf=5,
        random_state=42,
        class_weight='balanced'
    ))
])

# ---- 4. Stratified K-Fold ----
# Stratified = each fold keeps the same class distribution as the full set.
cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

print("\n🔍 Running 5-fold cross-validation...")
scores = cross_val_score(pipeline, X, y, cv=cv, scoring='accuracy')

print("\n📊 Per-fold accuracy:")
for i, s in enumerate(scores, 1):
    print(f"   Fold {i}: {s:.4f}")

mean_acc = scores.mean()
std_acc = scores.std()
print(f"\n📊 Mean accuracy : {mean_acc:.4f}")
print(f"📊 Std deviation : {std_acc:.4f}")
print(f"📊 Range         : {scores.min():.4f} to {scores.max():.4f}")

if std_acc < 0.02:
    print("✅ STABLE — accuracy varies less than 2% across folds")
elif std_acc < 0.05:
    print("⚠️  MODERATE — accuracy varies 2–5% across folds")
else:
    print("❌ FRAGILE — accuracy varies more than 5% across folds")

# ---- 5. Out-of-fold predictions ----
# Every sample is predicted exactly once by a model that didn't see it during training.
print("\n🔍 Generating out-of-fold predictions...")
y_pred_oof = cross_val_predict(pipeline, X, y, cv=cv)

print("\n📊 Classification report (out-of-fold — the honest view):")
print(classification_report(
    y, y_pred_oof,
    target_names=['Safe', 'Borderline', 'At Risk'],
    digits=4
))

print("📊 Confusion matrix (out-of-fold):")
cm = confusion_matrix(y, y_pred_oof)
print(f"{'':14s} {'Pred Safe':>10s} {'Pred Bord':>10s} {'Pred Risk':>10s}")
labels = ['Safe', 'Borderline', 'At Risk']
for i, name in enumerate(labels):
    row = '  '.join(f"{v:>8d}" for v in cm[i])
    print(f"True {name:>9s}:  {row}")

# ---- 6. Per-class recall (the number that matters most) ----
print("\n📊 Per-class recall:")
for i, name in enumerate(labels):
    total = cm[i].sum()
    if total > 0:
        recall = cm[i, i] / total
        print(f"   {name:12s}: {recall:.4f}  ({cm[i,i]}/{total} correct)")

# ---- 7. Interpretation ----
print("\n" + "=" * 60)
print("📌 INTERPRETATION")
print("=" * 60)
print(f"""
Mean accuracy: {mean_acc*100:.2f}% (± {std_acc*100:.2f}%)

This means: on any given 20% test split, we expect the model to be
correct about {mean_acc*100:.1f}% of the time, with {std_acc*100:.1f}% variation.

Compare to the single-split training result (train.py). If they're close,
the model is stable. If k-fold is much lower, the single split was lucky.
""")