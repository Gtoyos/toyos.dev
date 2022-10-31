import os
import pathlib
import time
import random
from . import quotes

class Cnt:
    def __init__(self):
        self.dates = {}
        for rootpth in ["toyos/templates/pages","toyos/static"]:
            for subdir, dirs, files in os.walk(rootpth):
                for file in files:
                    dt = time.gmtime(pathlib.Path(str(os.path.join(subdir, file))).stat().st_mtime)
                    dt = str(dt.tm_mday)+"/"+str(dt.tm_mon)+"/"+str(dt.tm_year)
                    self.dates[str(os.path.join(subdir, file))] = dt
        y = {}
        for key,val in self.dates.items():
            y["/".join(key.split("/")[2:])] = val
        self.dates = y
        self.qod = random.choice(quotes.QUOTES)
    def newQod(self):
        self.qod = random.choice(quotes.QUOTES)
        return self.qod