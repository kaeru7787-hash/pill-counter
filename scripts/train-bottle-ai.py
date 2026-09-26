"""Local supervised eyedrop-bottle prototype. Never uploads photographs.

Run prepare-bottle-training.mjs first. The square-cap source photograph stays
outside training. Its validation scores are developmental, not a blind trial.
"""
import os
os.environ['YOLO_CONFIG_DIR'] = os.path.abspath('work/bottle-ai/settings')
os.environ['OMP_NUM_THREADS'] = '4'
os.environ['MKL_NUM_THREADS'] = '4'
os.environ['MPLCONFIGDIR'] = os.path.abspath('work/bottle-ai/matplotlib')
import argparse, json, hashlib
from pathlib import Path
import torch
from ultralytics import YOLO

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--epochs',type=int,default=35)
    p.add_argument('--weights',default='yolo11n.pt')
    p.add_argument('--name',default='prototype')
    p.add_argument('--freeze',type=int,default=10)
    p.add_argument('--export-only',default='')
    a=p.parse_args()
    torch.set_num_threads(4)
    model=YOLO(a.export_only or a.weights)
    if not a.export_only:
      model.train(data='work/bottle-ai/dataset/data.yaml',epochs=a.epochs,
      imgsz=640,batch=4,device='cpu',workers=0,freeze=a.freeze,
      project=os.path.abspath('work/bottle-ai/runs'),name=a.name,exist_ok=True,
      seed=42,deterministic=True,optimizer='AdamW',lr0=.002,
      patience=0,cache=False,plots=False,save=True,
      degrees=35,translate=.12,scale=.35,fliplr=.5,flipud=.2,
      hsv_h=.04,hsv_s=.35,hsv_v=.25,mosaic=.5,close_mosaic=5,
      mixup=0,cutmix=0,amp=False)
    # Choose final epoch rather than optimize repeatedly on the lone validation photo.
    trained=YOLO(a.export_only or str(model.trainer.last))
    exported=Path(trained.export(format='onnx',imgsz=640,opset=17,
      simplify=False,dynamic=False,half=False,nms=False,batch=1,device='cpu'))
    report={'trainingPhotos':3,'validationPhotos':1,'trainingInstances':140,
      'classes':['eyedrop_bottle'],'base':a.weights,'epochs':a.epochs,
      'onnx':str(exported),'sha256':hashlib.sha256(exported.read_bytes()).hexdigest(),
      'limitation':'Only 4 source photos. Horizontal examples exist in a single training photo. No independent horizontal-bottle test set.',
      'annotationStatus':'Assistant-reviewed approximate visible-body boxes; provisional'}
    Path(f'work/bottle-ai/{a.name}-training.json').write_text(json.dumps(report,indent=2),encoding='utf-8')

if __name__=='__main__': main()
