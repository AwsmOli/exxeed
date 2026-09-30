-- Local development seed: the catalog rows for what this repo has data for.
-- The hosted catalog grows through report_session() as people drive.

insert into public.sims (id, name) values ('iracing', 'iRacing');

insert into public.car_classes (sim, class_id, name) values ('iracing', 'mx5', 'Mazda MX-5 Cup');

insert into public.cars (sim, car_id, name, class_id)
values ('iracing', 'mx5-mx52016', 'Global Mazda MX-5 Cup', 'mx5');

insert into public.track_layouts (sim, track_id, config_id, track_name, config_name, length_m) values
  ('iracing', 192, 'road-course', 'Daytona International Speedway', 'Road Course', 5687.29),
  ('iracing', 297, '300-circuit', 'Snetterton Circuit', '300 Circuit', 4735.35);
