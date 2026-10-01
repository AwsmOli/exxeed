
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "car_classes": {
                  Row: {
                    "class_id": string,"name": string,"sim": string
                  }
                  Insert: {
                    "class_id": string,"name": string,"sim": string
                  }
                  Update: {
                    "class_id"?: string,"name"?: string,"sim"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "car_classes_sim_fkey"
      columns: ["sim"]
isOneToOne: false
      referencedRelation: "sims"
      referencedColumns: ["id"]
    }
                  ]
                },"cars": {
                  Row: {
                    "car_id": string,"class_id": string | null,"name": string,"sim": string
                  }
                  Insert: {
                    "car_id": string,"class_id"?: string | null,"name": string,"sim": string
                  }
                  Update: {
                    "car_id"?: string,"class_id"?: string | null,"name"?: string,"sim"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cars_sim_class_id_fkey"
      columns: ["sim","class_id"]
isOneToOne: false
      referencedRelation: "car_classes"
      referencedColumns: ["sim","class_id"]
    },{
      foreignKeyName: "cars_sim_fkey"
      columns: ["sim"]
isOneToOne: false
      referencedRelation: "sims"
      referencedColumns: ["id"]
    }
                  ]
                },"content_drafts": {
                  Row: {
                    "item_id": string,"payload": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "item_id": string,"payload": NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "item_id"?: string,"payload"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_drafts_item_id_fkey"
      columns: ["item_id"]
isOneToOne: true
      referencedRelation: "content_items"
      referencedColumns: ["id"]
    }
                  ]
                },"content_files": {
                  Row: {
                    "bytes": number,"car_id": string | null,"id": string,"kind": string,"label": string,"path": string,"sha256": string,"version_id": string
                  }
                  Insert: {
                    "bytes": number,"car_id"?: string | null,"id"?: string,"kind": string,"label": string,"path": string,"sha256": string,"version_id": string
                  }
                  Update: {
                    "bytes"?: number,"car_id"?: string | null,"id"?: string,"kind"?: string,"label"?: string,"path"?: string,"sha256"?: string,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_setups_version_id_fkey"
      columns: ["version_id"]
isOneToOne: false
      referencedRelation: "content_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"content_items": {
                  Row: {
                    "based_on_version_id": string | null,"car_class": string | null,"config_id": string | null,"created_at": string,"download_count": number,"icon_path": string | null,"id": string,"kind": string,"latest_version": number | null,"latest_version_id": string | null,"owner": string,"readme": string,"removed": boolean,"search": unknown,"sim": string | null,"star_count": number,"summary": string,"title": string,"track_id": number | null,"track_label": string,"updated_at": string,"visibility": string
                  }
                  Insert: {
                    "based_on_version_id"?: string | null,"car_class"?: string | null,"config_id"?: string | null,"created_at"?: string,"download_count"?: number,"icon_path"?: string | null,"id"?: string,"kind": string,"latest_version"?: number | null,"latest_version_id"?: string | null,"owner"?: string,"readme"?: string,"removed"?: boolean,"search"?: never,"sim"?: string | null,"star_count"?: number,"summary"?: string,"title": string,"track_id"?: number | null,"track_label"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Update: {
                    "based_on_version_id"?: string | null,"car_class"?: string | null,"config_id"?: string | null,"created_at"?: string,"download_count"?: number,"icon_path"?: string | null,"id"?: string,"kind"?: string,"latest_version"?: number | null,"latest_version_id"?: string | null,"owner"?: string,"readme"?: string,"removed"?: boolean,"search"?: never,"sim"?: string | null,"star_count"?: number,"summary"?: string,"title"?: string,"track_id"?: number | null,"track_label"?: string,"updated_at"?: string,"visibility"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_items_based_on_version_id_fkey"
      columns: ["based_on_version_id"]
isOneToOne: false
      referencedRelation: "content_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_items_latest_version_id_fkey"
      columns: ["latest_version_id"]
isOneToOne: false
      referencedRelation: "content_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_items_owner_fkey"
      columns: ["owner"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_items_sim_track_id_config_id_fkey"
      columns: ["sim","track_id","config_id"]
isOneToOne: false
      referencedRelation: "track_layouts"
      referencedColumns: ["sim","track_id","config_id"]
    }
                  ]
                },"content_media": {
                  Row: {
                    "created_at": string,"id": string,"item_id": string,"kind": string,"path": string,"position": number
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"item_id": string,"kind": string,"path": string,"position"?: number
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"item_id"?: string,"kind"?: string,"path"?: string,"position"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_media_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "content_items"
      referencedColumns: ["id"]
    }
                  ]
                },"content_versions": {
                  Row: {
                    "changelog": string,"diff": Json | null,"download_count": number,"id": string,"item_id": string,"map_version": number | null,"payload": NonNullable<Json>,"published_at": string,"version": number,"voice_id": string | null,"withdrawn_at": string | null
                  }
                  Insert: {
                    "changelog"?: string,"diff"?: Json | null,"download_count"?: number,"id"?: string,"item_id": string,"map_version"?: number | null,"payload": NonNullable<Json>,"published_at"?: string,"version": number,"voice_id"?: string | null,"withdrawn_at"?: string | null
                  }
                  Update: {
                    "changelog"?: string,"diff"?: Json | null,"download_count"?: number,"id"?: string,"item_id"?: string,"map_version"?: number | null,"payload"?: NonNullable<Json>,"published_at"?: string,"version"?: number,"voice_id"?: string | null,"withdrawn_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_versions_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "content_items"
      referencedColumns: ["id"]
    }
                  ]
                },"downloads": {
                  Row: {
                    "created_at": string,"id": number,"installation_id": string,"user_id": string | null,"version_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: never,"installation_id": string,"user_id"?: string | null,"version_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: never,"installation_id"?: string,"user_id"?: string | null,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "downloads_version_id_fkey"
      columns: ["version_id"]
isOneToOne: false
      referencedRelation: "content_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_path": string | null,"created_at": string,"display_name": string,"id": string,"onboarded": boolean,"role": string
                  }
                  Insert: {
                    "avatar_path"?: string | null,"created_at"?: string,"display_name": string,"id": string,"onboarded"?: boolean,"role"?: string
                  }
                  Update: {
                    "avatar_path"?: string | null,"created_at"?: string,"display_name"?: string,"id"?: string,"onboarded"?: boolean,"role"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reference_laps": {
                  Row: {
                    "car_id": string,"config_id": string,"created_by": string | null,"data": NonNullable<Json>,"lap_time_s": number,"sim": string,"track_id": number,"updated_at": string
                  }
                  Insert: {
                    "car_id": string,"config_id": string,"created_by"?: string | null,"data": NonNullable<Json>,"lap_time_s": number,"sim": string,"track_id": number,"updated_at"?: string
                  }
                  Update: {
                    "car_id"?: string,"config_id"?: string,"created_by"?: string | null,"data"?: NonNullable<Json>,"lap_time_s"?: number,"sim"?: string,"track_id"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reference_laps_sim_car_id_fkey"
      columns: ["sim","car_id"]
isOneToOne: false
      referencedRelation: "cars"
      referencedColumns: ["sim","car_id"]
    },{
      foreignKeyName: "reference_laps_sim_track_id_config_id_fkey"
      columns: ["sim","track_id","config_id"]
isOneToOne: false
      referencedRelation: "track_layouts"
      referencedColumns: ["sim","track_id","config_id"]
    }
                  ]
                },"reports": {
                  Row: {
                    "created_at": string,"details": string,"id": number,"reason": string,"reporter": string,"resolution": string | null,"resolved_at": string | null,"target_id": string,"target_kind": string
                  }
                  Insert: {
                    "created_at"?: string,"details"?: string,"id"?: never,"reason": string,"reporter"?: string,"resolution"?: string | null,"resolved_at"?: string | null,"target_id": string,"target_kind": string
                  }
                  Update: {
                    "created_at"?: string,"details"?: string,"id"?: never,"reason"?: string,"reporter"?: string,"resolution"?: string | null,"resolved_at"?: string | null,"target_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    
                  ]
                },"sims": {
                  Row: {
                    "id": string,"name": string
                  }
                  Insert: {
                    "id": string,"name": string
                  }
                  Update: {
                    "id"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"stars": {
                  Row: {
                    "created_at": string,"item_id": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"item_id": string,"user_id"?: string
                  }
                  Update: {
                    "created_at"?: string,"item_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stars_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "content_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stars_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"track_layouts": {
                  Row: {
                    "config_id": string,"config_name": string,"created_at": string,"length_m": number | null,"sim": string,"track_id": number,"track_name": string,"turn_numbers": NonNullable<Json>
                  }
                  Insert: {
                    "config_id": string,"config_name"?: string,"created_at"?: string,"length_m"?: number | null,"sim": string,"track_id": number,"track_name": string,"turn_numbers"?: NonNullable<Json>
                  }
                  Update: {
                    "config_id"?: string,"config_name"?: string,"created_at"?: string,"length_m"?: number | null,"sim"?: string,"track_id"?: number,"track_name"?: string,"turn_numbers"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "track_layouts_sim_fkey"
      columns: ["sim"]
isOneToOne: false
      referencedRelation: "sims"
      referencedColumns: ["id"]
    }
                  ]
                },"track_maps": {
                  Row: {
                    "config_id": string,"created_at": string,"created_by": string | null,"data": NonNullable<Json>,"map_version": number,"sim": string,"track_id": number
                  }
                  Insert: {
                    "config_id": string,"created_at"?: string,"created_by"?: string | null,"data": NonNullable<Json>,"map_version": number,"sim": string,"track_id": number
                  }
                  Update: {
                    "config_id"?: string,"created_at"?: string,"created_by"?: string | null,"data"?: NonNullable<Json>,"map_version"?: number,"sim"?: string,"track_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "track_maps_sim_track_id_config_id_fkey"
      columns: ["sim","track_id","config_id"]
isOneToOne: false
      referencedRelation: "track_layouts"
      referencedColumns: ["sim","track_id","config_id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "is_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"owns_item_folder":
{ Args: { "object_name": string }; Returns: boolean
                           },
"publish_version":
{ Args: { "p_changelog"?: string,"p_diff"?: Json,"p_files"?: Json,"p_item_id": string,"p_map_version"?: number,"p_payload": Json,"p_voice_id"?: string }; Returns: {
              "changelog": string,
"diff": Json | null,
"download_count": number,
"id": string,
"item_id": string,
"map_version": number | null,
"payload": NonNullable<Json>,
"published_at": string,
"version": number,
"voice_id": string | null,
"withdrawn_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "content_versions"
        isOneToOne: true
        isSetofReturn: false
      } },
"record_download":
{ Args: { "p_installation_id": string,"p_version_id": string }; Returns: undefined
                           },
"report_session":
{ Args: { "p_car_id": string,"p_car_name": string,"p_config_id": string,"p_config_name": string,"p_length_m": number,"p_sim": string,"p_track_id": number,"p_track_name": string }; Returns: undefined
                           },
"set_item_removed":
{ Args: { "p_item_id": string,"p_removed": boolean }; Returns: undefined
                           },
"submit_map":
{ Args: { "p_config_id": string,"p_data": Json,"p_sim": string,"p_track_id": number }; Returns: {
              "accepted": boolean,"map_version": number
            }[]
                           },
"submit_reference_lap":
{ Args: { "p_car_id": string,"p_config_id": string,"p_data": Json,"p_lap_time_s": number,"p_sim": string,"p_track_id": number }; Returns: boolean
                           },
"withdraw_version":
{ Args: { "p_version_id": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const

