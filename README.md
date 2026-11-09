# 台灣好味道抽籤所 – Hướng dẫn backend

## Cấu trúc thư mục

```
food-app/
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── foods.json        ← tên phải viết thường đúng như vầy (app.js gọi ./foods.json)
├── backend/
│   ├── main.py           ← server FastAPI, các endpoint /api/...
│   ├── claude_service.py ← gọi Claude API để chọn món
│   ├── maps_service.py   ← gọi Google Places API để tìm quán
│   ├── usage_tracker.py  ← đếm chi phí theo tháng, hết ngân sách thì ngừng gọi API
│   ├── requirements.txt
│   └── .env.example      ← mẫu file chứa API key
└── .gitignore            ← chặn .env và usage.json khỏi bị đẩy lên GitHub
```

## Chạy thử lần đầu

```bash
cd food-app/backend
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt

# Tạo file .env từ file mẫu rồi điền key vào
# Windows:      copy .env.example .env
# macOS/Linux:  cp .env.example .env

uvicorn main:app --reload
```

Mở **http://127.0.0.1:8000**. Phải mở bằng địa chỉ này, không dùng Live Server của VS Code, vì frontend và `/api/...` cần chạy chung một server.

**Chưa có key vẫn chạy được:**
- Không có `ANTHROPIC_API_KEY`: chế độ AI推薦 tự chuyển sang bốc ngẫu nhiên và ghi rõ lý do.
- Không có `GOOGLE_MAPS_API_KEY`: nút 附近餐廳 báo "尚未設定".

## Lấy API key

### Claude API
1. Vào https://platform.claude.com, tạo tài khoản và nạp một ít credit.
2. Vào mục API Keys, tạo key mới và dán vào `ANTHROPIC_API_KEY=` trong `.env`.
3. Model mặc định là `claude-haiku-5-5`, model rẻ nhất hiện tại. Mỗi lần gợi ý tốn khoảng 0,0003–0,0005 USD, nên 3 USD/tháng đủ cho vài nghìn lượt.

### Google Places API (New)
1. Vào https://console.cloud.google.com, tạo project và bật **Billing**. Bắt buộc phải bật, kể cả khi chỉ dùng trong mức miễn phí.
2. Vào APIs & Services, chọn Library, tìm **Places API (New)** và bấm Enable. Lưu ý chọn bản *New*, không phải bản Legacy.
3. Vào Credentials, tạo API key. Bấm vào key, chọn **API restrictions** và chỉ cho phép *Places API (New)*.
4. **Nên làm thêm:** vào Places API (New), mở tab Quotas và giới hạn số request mỗi ngày (ví dụ 30/ngày). Đây là "phanh tay" phía Google, phòng khi code có lỗi.
5. Dán key vào `GOOGLE_MAPS_API_KEY=` trong `.env`.

## Cách chạy bên trong

**AI推薦 (`POST /api/recommend`)**
1. Frontend lọc món theo khẩu vị rồi gửi danh sách ứng viên lên.
2. Backend **chỉ tin id món**. Thông tin món được đọc lại từ `foods.json` của server, để người dùng không sửa dữ liệu gửi lên được.
3. Bỏ món vừa gợi ý ở lượt trước, rồi gửi cho Claude: khẩu vị, tâm trạng và danh sách món.
4. Claude trả về JSON `{foodId, reason}`. JSON schema giới hạn `foodId` chỉ được là id có trong danh sách, nên Claude **không bịa món được**. Backend vẫn kiểm tra lại lần nữa.
5. Khi Claude lỗi, hết ngân sách tháng, hoặc chưa có key thì backend bốc ngẫu nhiên. App vẫn chạy bình thường.

**附近餐廳 (`POST /api/nearby`)**
1. Người dùng bấm 📍 尋找附近餐廳. Trình duyệt hỏi quyền định vị.
2. Nếu từ chối định vị, người dùng có thể gõ khu vực, ví dụ `台北市大安區`.
3. Backend tìm kiểu "牛肉麵" quanh vị trí đó (bán kính 2 km) và lấy tối đa 9 quán. Frontend hiện 3 quán một lần, bấm 再找 3 家 để xem 3 quán tiếp theo. Cả 9 quán chỉ tốn **1 request**.

## Chi phí và giới hạn (chỉnh trong `.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CLAUDE_MONTHLY_BUDGET_USD` | 3 | Vượt mức này thì ngừng gọi Claude, chuyển sang random |
| `PLACES_MONTHLY_LIMIT` | 900 | Số lần tìm quán mỗi tháng (Google miễn phí 1.000 lần) |
| `RATE_LIMIT_PER_MINUTE` | 10 | Mỗi người tối đa 10 request/phút cho mỗi API |

Số liệu đã dùng được lưu trong `backend/usage.json` và tự reset mỗi tháng. Giá trên đúng tại thời điểm viết (11/2026). Nên kiểm tra lại trang giá của Anthropic và Google trước khi deploy.

**Về Google:** code dùng `rating` (số sao) nên mỗi lần tìm thuộc gói *Text Search Enterprise*: 1.000 lần/tháng miễn phí, sau đó 35 USD/1.000 lần. Muốn thêm field mới vào `FIELD_MASK` trong `maps_service.py` thì kiểm tra giá trước, vì có field sẽ đẩy request lên gói đắt hơn.

## Lưu ý bảo mật
- **Không bao giờ** đẩy file `.env` lên GitHub. `.gitignore` đã chặn sẵn.
- Key chỉ nằm ở backend. Frontend không bao giờ thấy key.
