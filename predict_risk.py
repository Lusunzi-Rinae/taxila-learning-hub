import joblib
import json
import sys
import os
import pandas as pd

MODEL_PATH = 'models/risk_model.pkl'
SCALER_PATH = 'models/scaler.pkl'
FEATURES_PATH = 'models/features.json'
LABELS_PATH = 'models/labels.json'

if not os.path.exists(MODEL_PATH):
    print(json.dumps({"error": "Model not found. Run train.py first."}))
    sys.exit(1)

model = joblib.load(MODEL_PATH)
scaler = joblib.load(SCALER_PATH)

with open(FEATURES_PATH) as f:
    feature_names = json.load(f)

with open(LABELS_PATH) as f:
    labels_map = json.load(f)

if len(sys.argv) < 2:
    print(json.dumps({"error": "No data provided"}))
    sys.exit(1)

# If the argument is a file path, read from it; otherwise treat it as raw JSON
arg = sys.argv[1]
try:
    if os.path.exists(arg):
        with open(arg, 'r', encoding='utf-8-sig') as fh:
            student = json.loads(fh.read())
    else:
        student = json.loads(arg)
except (json.JSONDecodeError, OSError) as e:
    print(json.dumps({"error": f"Invalid JSON or file: {e}"}))
    sys.exit(1)

# Build feature row
row = {}
missing = []
for feat in feature_names:
    if feat in student and student[feat] is not None:
        try:
            row[feat] = [float(student[feat])]
        except (TypeError, ValueError):
            row[feat] = [0.0]
            missing.append(feat)
    else:
        row[feat] = [0.0]
        missing.append(feat)

df = pd.DataFrame(row)
scaled = scaler.transform(df)

# Predict
predicted_class = int(model.predict(scaled)[0])
probabilities = model.predict_proba(scaled)[0]   # array indexed by model.classes_

# Map each class index to its probability
class_probs = {int(c): float(p) for c, p in zip(model.classes_, probabilities)}

risk_level = labels_map.get(str(predicted_class), "Unknown")
confidence = round(class_probs.get(predicted_class, 0) * 100, 1)

# at_risk probability (for downstream use)
prob_at_risk = round(class_probs.get(2, 0) * 100, 1)

result = {
    "risk_level": risk_level,
    "confidence": confidence,
    "probability_at_risk": prob_at_risk,
    "probabilities": {
        "Safe": round(class_probs.get(0, 0) * 100, 1),
        "Borderline": round(class_probs.get(1, 0) * 100, 1),
        "At Risk": round(class_probs.get(2, 0) * 100, 1)
    },
    "features_used": {k: v[0] for k, v in row.items()},
    "missing_features": missing
}

print(json.dumps(result))